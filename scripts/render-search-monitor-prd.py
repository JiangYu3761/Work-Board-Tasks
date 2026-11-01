#!/usr/bin/env python3
"""Render the local search monitoring PRD into a self-contained reading copy."""
from pathlib import Path
from html import escape
import re
from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/搜索词监控需求设计文档.md"
TARGET = SOURCE.with_suffix(".html")
md = MarkdownIt("commonmark", {"html": False}).enable("table")
text = SOURCE.read_text(encoding="utf-8")
title, body = text.split("\n", 1)
title = title.removeprefix("# ")
parts = re.split(r"(?m)^## (.+)\n", body)
intro = md.render(parts[0])
sections, links = [], []
for index in range(1, len(parts), 2):
    heading, content = parts[index:index + 2]
    number = heading.split(" ", 1)[0]
    anchor = "section-" + number
    links.append(f'<a href="#{anchor}"><span>{number.zfill(2)}</span>{escape(heading.split(" ", 1)[1])}</a>')
    sections.append(f'<section class="chapter" id="{anchor}"><h2>{escape(heading)}</h2>{md.render(content)}</section>')
rendered = "\n".join(sections)
rendered = rendered.replace('<table>', '<div class="table-scroll" tabindex="0"><table>').replace('</table>', '</table></div>')

css = r"""
:root{--ink:#162b2b;--muted:#536763;--line:#d8e3de;--paper:#fff;--bg:#f3f6f2;--accent:#1c6655;--mint:#dcece2;--gold:#bc802a}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:88px}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}a{color:var(--accent);text-underline-offset:3px}button{font:inherit;cursor:pointer}header{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 32px;background:#f3f6f2f5;border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}.brand{font-weight:750;letter-spacing:.09em;font-size:15px}.edition{font-size:12px;color:var(--muted);letter-spacing:.05em}.actions{display:flex;align-items:center;gap:10px}.actions a,.actions button{border:1px solid var(--line);border-radius:8px;padding:6px 12px;background:white;color:var(--ink);font-size:13px;text-decoration:none}.layout{display:grid;grid-template-columns:252px minmax(0,1fr);max-width:1540px;margin:auto;gap:40px;padding:32px}aside{position:sticky;top:100px;max-height:calc(100vh - 125px);overflow-y:auto;align-self:start;padding-right:8px}.toc-label{font-size:11px;color:var(--muted);letter-spacing:.13em;margin:0 0 12px}nav{display:grid;gap:3px}nav a{display:flex;align-items:baseline;gap:12px;padding:8px 10px;border-radius:7px;text-decoration:none;font-size:12px;line-height:1.5;color:var(--muted)}nav a span{font-size:10px;color:#7b9188;font-variant-numeric:tabular-nums}nav a:hover,nav a.active{background:var(--mint);color:var(--accent)}main{min-width:0;max-width:1120px}.hero{background:var(--ink);color:#fff;padding:44px 42px;border-radius:18px;margin-bottom:28px}.eyebrow{font-size:12px;letter-spacing:.14em;color:#b4d4c4}.hero h1{font-size:36px;line-height:1.4;letter-spacing:-.02em;font-weight:680;margin:16px 0}.hero p{color:#d0dfd8;max-width:720px;margin:12px 0 0;font-size:15px}.badges{display:flex;gap:8px;flex-wrap:wrap;margin-top:26px}.badges span{font-size:11px;border:1px solid #5b7770;padding:4px 10px;border-radius:20px;color:#e1ece7}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 26px}.summary div{border:1px solid var(--line);background:var(--paper);border-radius:11px;padding:18px}.summary b{display:block;font-size:15px;margin-bottom:5px}.summary span{font-size:12px;line-height:1.7;color:var(--muted);display:block}.intro,.chapter{background:white;border:1px solid var(--line);border-radius:12px;padding:30px 34px;margin-bottom:22px;overflow-wrap:anywhere}.intro{border-left:4px solid var(--gold)}.intro>p:first-child{font-size:12px;color:var(--muted)}h2{font-size:25px;line-height:1.5;letter-spacing:-.01em;margin:0 0 24px;padding-bottom:16px;border-bottom:1px solid var(--line)}h3{font-size:19px;margin:30px 0 14px;color:var(--accent)}p{margin:14px 0}li{padding-left:3px;margin:7px 0}ul,ol{padding-left:24px}strong{font-weight:650}.table-scroll{overflow-x:auto;margin:20px 0;border:1px solid var(--line);border-radius:9px;scrollbar-width:thin}table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.75;min-width:620px}th{background:#eaf0eb;font-size:12px;font-weight:650;text-align:left;color:#294f43}th,td{padding:12px 14px;vertical-align:top;border-bottom:1px solid var(--line);border-right:1px solid #e8ede9}th:last-child,td:last-child{border-right:0}tr:last-child td{border-bottom:0}tbody tr:nth-child(even){background:#fafcf9}td:first-child{font-weight:550;min-width:95px}pre{background:#f0f5f1;border:1px solid var(--line);border-radius:9px;padding:22px;overflow:auto;font-size:12px;line-height:1.9}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;background:#eef3ee;padding:2px 4px;border-radius:3px}pre code{padding:0;background:none;font-size:inherit;white-space:pre}footer{padding:18px 0 36px;color:var(--muted);font-size:12px}.top-link{display:inline-block;margin-top:8px}.progress{position:fixed;left:0;top:0;height:3px;background:#73b89a;z-index:99;width:0}.mobile-nav{display:none}.scope-callout{background:#edf4ee;padding:18px 24px;border-radius:11px;margin:0 0 26px;font-size:13px;color:#335647}.scope-callout b{margin-right:8px}a:focus-visible,button:focus-visible,.table-scroll:focus-visible{outline:3px solid #9ac7ab;outline-offset:3px}
@media(min-width:1550px){.layout{gap:55px}}
@media(max-width:1050px){.layout{grid-template-columns:210px minmax(0,1fr);gap:22px;padding:22px}.hero{padding:32px}.hero h1{font-size:29px}.chapter,.intro{padding:25px}.summary{grid-template-columns:repeat(2,1fr)}}
@media(max-width:760px){header{padding:12px 16px}.edition{display:none}.actions a,.actions button{font-size:11px;padding:5px 8px}.layout{display:block;padding:16px}.mobile-nav{display:block;width:100%;padding:10px;margin-bottom:16px;border:1px solid var(--line);border-radius:8px;background:white;color:var(--ink)}aside{display:none}.hero{padding:26px 24px;border-radius:12px}.hero h1{font-size:27px}.hero p{font-size:13px}.summary{gap:8px}.summary div{padding:14px}.summary b{font-size:13px}.summary span{font-size:11px}.chapter,.intro{padding:22px 18px}h2{font-size:22px}h3{font-size:18px}body{font-size:15px}.scope-callout{padding:16px}}
@media print{@page{size:A4;margin:16mm}header,aside,.progress,.mobile-nav,.actions,.top-link{display:none!important}body{background:white;font-size:10pt;line-height:1.65}.layout{display:block;padding:0;max-width:none}main{max-width:none}.hero{background:white;color:#162b2b;border:2px solid #162b2b;border-radius:0;padding:24px}.hero p,.eyebrow{color:#335647}.hero h1{font-size:24pt}.badges span{color:#335647}.summary{grid-template-columns:repeat(3,1fr)}.intro,.chapter{border:0;padding:0;border-radius:0;margin-bottom:20px;overflow:visible}h2{font-size:17pt;break-after:avoid;margin-top:30px}h3{font-size:12pt;break-after:avoid}p{orphans:3;widows:3}.table-scroll{overflow:visible;border-radius:0}table{min-width:0;font-size:8.5pt;table-layout:auto}th,td{padding:6px 7px;overflow-wrap:anywhere}thead{display:table-header-group}tr{break-inside:avoid}pre{white-space:pre-wrap;font-size:8pt}pre code{white-space:pre-wrap}.summary div{padding:10px}a{color:inherit;text-decoration:none}.scope-callout{background:white;border:1px solid #ccc}footer{font-size:9pt}}
"""
options = ''.join(f'<option value="section-{i}">{i:02d} {escape(parts[2*i-1].split(" ",1)[1])}</option>' for i in range(1,21))
page = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>{escape(title)}</title><style>{css}</style></head>
<body id="top"><div class="progress" aria-hidden="true"></div>
<header><div><span class="brand">北向 NORTH</span><span class="edition">　产品需求设计 · 2026.10.25</span></div><div class="actions"><a href="搜索词监控需求设计文档.md">可编辑原稿</a><button type="button" id="print">打印 / 保存 PDF</button></div></header>
<div class="layout"><aside><p class="toc-label">文档目录 · 20 个章节</p><nav aria-label="文档目录">{''.join(links)}</nav></aside><main>
<select class="mobile-nav" aria-label="跳转章节"><option value="top">跳转到章节</option>{options}</select>
<div class="hero"><div class="eyebrow">NORTH / AMAZON SEARCH MONITORING</div><h1>搜索词监控<br>需求设计文档</h1><p>持续观察自然排名、广告位置、品牌商品覆盖与销量，集中追踪 HOMA 的搜索表现，让每一次变化都能回到当时的页面证据。</p><div class="badges"><span>V0.9 需求评审稿</span><span>2026 年 10 月 25 日</span><span>监控尚未启用</span></div></div>
<div class="summary"><div><b>产品自然排名</b><span>趋势、出现率、头部位置与跨页排名</span></div><div><b>广告位置与类型</b><span>模块、商品卡、素材形式、区域与目标</span></div><div><b>品牌覆盖与销量</b><span>链接去重、估算周期、覆盖率与固定集合</span></div><div><b>品牌广告占位</b><span>明确分母的采样份额与可比时段变化</span></div><div><b>HOMA 专属看板</b><span>产品与词矩阵、目标位置、异常与检查</span></div><div><b>持续监控与验收</b><span>任务调度、质量检查、证据与 34 项用例</span></div></div>
<div class="scope-callout"><b>建议首期范围</b>美国站 · 60202 · 桌面端 · 每词前 3 页 · 每天 3 次。HOMA ASIN、首批词表与销量来源待确认。详见<a href="#section-19">待确认事项</a>。</div>
<div class="intro">{intro}</div>
{rendered}
<footer>北向 NORTH · 本地项目文档 · 需求设计与运行实现分别验收。<br><a class="top-link" href="#top">返回顶部 ↑</a></footer>
</main></div>
<script>
document.querySelector('#print').addEventListener('click',()=>window.print());
document.querySelector('.mobile-nav').addEventListener('change',e=>document.getElementById(e.target.value)?.scrollIntoView());
const chapters=[...document.querySelectorAll('.chapter')];
const navLinks=[...document.querySelectorAll('nav a')];
function update(){{const max=document.documentElement.scrollHeight-innerHeight;document.querySelector('.progress').style.width=(max?100*scrollY/max:0)+'%';let current=chapters[0];for(const c of chapters){{if(c.getBoundingClientRect().top<180)current=c;}}for(const a of navLinks){{const active=a.hash==='#'+current.id;a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');}}}}
addEventListener('scroll',update,{{passive:true}});update();
</script></body></html>'''
TARGET.write_text(page, encoding="utf-8")
print(f"Rendered {len(sections)} sections, {rendered.count('<table>')} tables → {TARGET}")
