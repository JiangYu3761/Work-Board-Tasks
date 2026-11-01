import {bridgeEvents,transaction} from './events.mjs';
import {channelConfig,deliverFeishu} from './feishu.mjs';

export async function deliverOne(pool,config=channelConfig(),transport=deliverFeishu,{deliveryId=null}={}) {
  // A crash after sending but before persisting its receipt is an uncertain delivery.
  await pool.query("UPDATE north_deliveries SET state='uncertain',last_error='WORKER_INTERRUPTED',lease_until=NULL,updated_at=now() WHERE state='sending' AND lease_until<now()");
  if(!config.configured)return null;
  const item=await transaction(pool,async c=>{
    const row=(await c.query("SELECT * FROM north_deliveries WHERE state='queued' AND available_at<=now() AND ($1::uuid IS NULL OR id=$1) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",[deliveryId])).rows[0];
    if(!row)return null;
    return (await c.query("UPDATE north_deliveries SET state='sending',attempts=attempts+1,lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0];
  });
  if(!item)return null;
  const event=(await pool.query('SELECT * FROM north_events WHERE id=$1',[item.event_id])).rows[0];
  let outcome;try{outcome=await transport(item,event,config);}catch{outcome={state:'uncertain',error:'TRANSPORT_INTERRUPTED'};}
  await pool.query("UPDATE north_deliveries SET state=$2,provider_message_id=$3,last_error=$4,lease_until=NULL,updated_at=now() WHERE id=$1 AND state='sending'",[item.id,outcome.state,outcome.message_id||null,outcome.error||null]);
  return {id:item.id,...outcome};
}
export function startIntegrationWorker(pool) {
  let stopped=false,running=null;
  const tick=()=>{
    if(stopped||running)return;
    running=(async()=>{await bridgeEvents(pool);if(!stopped)await deliverOne(pool);})()
      .catch(async()=>{console.error('Integration worker failed');await pool.query("UPDATE north_integration_state SET last_error='INTEGRATION_WORKER_FAILED' WHERE id=1").catch(()=>{});})
      .finally(()=>{running=null;});
  };
  const timer=setInterval(tick,10000);timer.unref();tick();
  return {wake:tick,stop:async()=>{stopped=true;clearInterval(timer);await running;}};
}
