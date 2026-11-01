// Shared by the browser and the Node regression checks.
globalThis.RivalCalendar=(()=>{
  const isAnnouncement=e=>['launch','promotion','important'].includes(e.kind);
  function range(today,year=0,month=''){
    let start,end;
    if(year){start=`${year}-01-01`;end=`${year}-12-31`;}
    else{
      const [y,m,d]=today.split('-').map(Number);
      const day=Math.min(d,new Date(Date.UTC(y-1,m,0)).getUTCDate());
      start=`${y-1}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;end=today;
    }
    if(month){const [y,m]=month.split('-').map(Number);start=[start,month+'-01'].sort().at(-1);end=[end,new Date(Date.UTC(y,m,0)).toISOString().slice(0,10)].sort()[0];}
    return {start,end};
  }
  function months(today,year=0){
    const {start,end}=range(today,year),out=[];
    const d=new Date(start.slice(0,7)+'-01T00:00:00Z');
    while(d.toISOString().slice(0,10)<=end){out.push(d.toISOString().slice(0,7));d.setUTCMonth(d.getUTCMonth()+1);}
    return out;
  }
  function filter(events,{today,year=0,month='',kind='announcements',query=''}={}){
    const {start,end}=range(today,year,month),needle=query.toLowerCase();
    return events.filter(e=>e.published_on>=start&&e.published_on<=end&&
      (kind==='all'||(kind==='announcements'?isAnnouncement(e):kind==='promotion'?(e.kind==='promotion'||Boolean(e.source_meta?.promotion_window)):e.kind===kind))&&
      (!needle||`${e.title} ${e.summary} ${e.source_meta?.source_title||''}`.toLowerCase().includes(needle)));
  }
  return {range,months,filter,isAnnouncement};
})();
