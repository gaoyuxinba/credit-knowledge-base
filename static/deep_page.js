/* ==========================================================================
 * 行业总表（V12.3 起并入数据看板顶部视图）+ 小微行业交叉验证看板（V11.0）
 * --------------------------------------------------------------------------
 * 依赖：core_taxonomy.js / profile.js / cross_engine.js / app.js 已加载
 *
 * V11.0 改动（按用户反馈）：
 *   1. 「行业深度档案」改名「小微行业交叉验证看板」；不展示撰写角色、免责声明等 AI 痕迹
 *   2. 删除「数据体检」分组 —— 数据矛盾已在编译阶段改完，页面只给结果，不展示修改过程
 *   3. 明细改为「组内目录 + 卡片 + 数值高亮」，一眼看得出结构
 *   4. 全站禁用「钩子」「勾稽」等黑话
 * ========================================================================== */
'use strict';

var DOS_TAB = 'A';
var DOS_FILTER = { tier: 'all', cat: 'all', q: '' };
var BOARD_FILTER = { tier: 'all', cat: 'all', q: '' };

/* 修改过程字段：一律不对外展示（数据本身保留在库里备查） */
var PROCESS_KEYS = ['现有值', '矛盾点', '修正建议', '影响', '严重度', '编号'];
/* 技术字段：expr / 阈值 / 引擎内部键名 等属于引擎内部配置，不对外展示 */
var TECH_KEYS = ['id', 'key', 'type', 'expr', 'expr_low', 'expr_high', 'mode', '参数', 'actual', '阈值', 'vars', '单位'];
/* 元数据字段：单独渲染到卡片脚注 */
var META_KEYS = ['depth_level', 'source', 'confidence', 'author', 'verified_at'];

/* 少数字段名本身是英文，作为表头显示时要换成中文 */
var KEY_LABEL = {
  dim: '验证维度', mode: '判定方式', key: '标识', type: '类型', id: '编号',
  '待补城市': '未做实地调研的城市', '待补说明': '关于这些城市', '城市档案': '逐城调研结论',
  '口径警告': '口径提醒'
};
function kLabel(k) { return KEY_LABEL[String(k)] || k; }

/* 档案分组：人话标题 + 一句话说明 */
var DOS_GROUPS = [
  { k: 'A', f: 'A_准入', t: '准入与证照', d: '这个行业到底算不算、要看哪些证、什么情况直接拒' },
  { k: 'B', f: 'B_单产模型', t: '单产与成本', d: '这门生意怎么赚钱、赚多少、钱花在哪' },
  { k: 'C', f: 'C_产业链', t: '上下游与结算', d: '上游谁供货、下游谁付钱、账期多长、被谁挤压' },
  { k: 'D', f: 'D_失败与包装', t: '失败与造假手法', d: '这个行业怎么死的、怎么被包装的、怎么一击戳穿' },
  { k: 'E', f: 'E_交叉验证', t: '验证口径与处置', d: '各项交叉验证的判定依据与偏离后怎么处置' },
  { k: 'F', f: 'F_额度与用途', t: '额度与资金用途', d: '能给多少、期限怎么排、押品怎么折、钱用到哪' },
  { k: 'G', f: 'G_岗位核验', t: '岗位核验', d: '老板和关键岗位该问什么、答不上说明什么' },
  { k: 'H', f: 'H_城市差异', t: '城市差异', d: '同一行业在不同城市的关键差别' }
];

/* ---------------- 渲染工具 ---------------- */

/* 当前档案的「变量名 → 中文名」映射：档案正文里偶尔会写出引擎变量名（如 eff / acRev），
   直接显示就是一堆英文，这里按本档案自己的定义换回人话 */
var CUR_VAR_MAP = null;

function dpBuildVarMap(p) {
  const map = {};
  const E = (p && p.dossier && p.dossier.E_交叉验证) ? p.dossier.E_交叉验证 : null;
  const inputs = E && E['通用输入项'];
  if (!Array.isArray(inputs)) return map;
  inputs.forEach(function (it) {
    if (!it || typeof it !== 'object') return;
    if (it.key && it['名称']) map[it.key] = String(it['名称']);
    const opts = it['选项'];
    if (Array.isArray(opts)) {
      opts.forEach(function (o) {
        if (!o || !o.vars || typeof o.vars !== 'object') return;
        Object.keys(o.vars).forEach(function (k) { if (!(k in map)) map[k] = '档位参数'; });
      });
    }
  });
  return map;
}

function dpVarReplace(t) {
  if (!CUR_VAR_MAP) return t;
  Object.keys(CUR_VAR_MAP).forEach(function (k) {
    if (k.length < 2 || k.length > 16) return;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) return;
    t = t.replace(new RegExp('\\b' + k + '\\b', 'g'), CUR_VAR_MAP[k]);
  });
  return t;
}

/* 转义 + 术语白话化（档案正文里的「钩子 / 勾稽」等内部说法统一替换） */
function pt(s) {
  var t = XWK_TAXO.plainText(esc(s === undefined || s === null ? '' : String(s)));
  return dpVarReplace(t);
}

/* 数值高亮：把「58%」「300万」「90天」这类关键数字加粗标色
   兜底：万一传进来的是对象，展开成键值，绝不显示成 [object Object] */
function dpText(s) {
  if (s && typeof s === 'object') {
    return Array.isArray(s) ? (s.length ? dpList(s) : '') : dpKV(dpStrip(s));
  }
  var t = pt(s);
  t = t.replace(/(\d+(?:\.\d+)?)\s*(%|个百分点|万元|亿元|元|万|天|个月|年|人|㎡|台|次|倍|张|家|笔)/g,
    '<b style="color:#0f766e;font-weight:700;">$1$2</b>');
  return t;
}

function dpStrip(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  var r = {};
  Object.keys(o).forEach(function (k) {
    if (PROCESS_KEYS.indexOf(k) >= 0) return;
    if (TECH_KEYS.indexOf(k) >= 0) return;
    r[k] = o[k];
  });
  return r;
}

function dpMetaLine(o) {
  if (!o || typeof o !== 'object') return '';
  var m = [];
  if (o.source) m.push('来源：' + esc(o.source));
  if (o.confidence) m.push('置信度：' + esc(o.confidence));
  if (o.verified_at) m.push('核验日期：' + esc(o.verified_at));
  if (!m.length) return '';
  return '<div style="margin-top:10px;padding:7px 11px;background:#f8fafc;border-left:3px solid #cbd5e1;' +
    'border-radius:0 4px 4px 0;color:#64748b;font-size:11.5px;line-height:1.7;">' + m.join('　｜　') + '</div>';
}

/* 表格：数组 of 对象 */
function dpTable(rows) {
  var keys = [];
  rows.forEach(function (r) {
    if (r && typeof r === 'object') Object.keys(r).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
  });
  var show = keys.filter(function (k) {
    return META_KEYS.indexOf(k) < 0 && PROCESS_KEYS.indexOf(k) < 0 && TECH_KEYS.indexOf(k) < 0;
  });
  if (!show.length) return '';
  var h = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;">';
  h += '<tr>' + show.map(function (k) {
    return '<th style="text-align:left;padding:9px 11px;background:#f1f5f9;border-bottom:2px solid #cbd5e1;' +
      'color:#334155;white-space:nowrap;font-weight:600;">' + pt(kLabel(k)) + '</th>';
  }).join('') + '</tr>';
  rows.forEach(function (row, ri) {
    h += '<tr style="' + (ri % 2 ? 'background:#fcfdfe;' : '') + '">';
    show.forEach(function (k) {
      h += '<td style="padding:9px 11px;border-bottom:1px solid #eef2f7;vertical-align:top;line-height:1.75;">' + dpCell(k, row[k]) + '</td>';
    });
    h += '</tr>';
  });
  return h + '</table></div>';
}

/* 追问分支：把「客户这么答 → 这么追问 → 怎么判」画成链条，比表格好读 */
function dpBranch(arr) {
  return '<div style="display:flex;flex-direction:column;gap:8px;">' + arr.map(function (b) {
    const o = dpStrip(b);
    let s = '<div style="border:1px dashed #cbd5e1;border-radius:7px;padding:9px 12px;background:#fcfdfe;">';
    Object.keys(o).forEach(function (k) {
      const v = o[k];
      if (v === undefined || v === null || v === '') return;
      const label = k === '条件' ? '客户这么答' : kLabel(k);
      s += '<div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:12.5px;line-height:1.75;">' +
        '<div style="color:#64748b;font-weight:600;white-space:nowrap;">' + pt(label) + '</div>' +
        '<div style="color:#334155;">' + dpText(v) + '</div></div>';
    });
    return s + '</div>';
  }).join('') + '</div>';
}

/* 单元格取值：分支走追问链，其余按类型展开 */
function dpCell(k, v) {
  if (k === '分支' && Array.isArray(v)) return dpBranch(v);
  if (v && typeof v === 'object' && !Array.isArray(v)) return dpKV(v);
  if (Array.isArray(v)) return dpList(v);
  return dpText(v);
}

/* 列表：数组 of 基本类型。
   元素若仍是对象（如「分支」「选项」），转成表格展开 —— 直接拼接会显示成 [object Object] */
function dpList(arr) {
  if (!arr || !arr.length) return '';
  if (typeof arr[0] === 'object' && arr[0] !== null) return dpTable(arr.map(dpStrip));
  return '<ol style="margin:0;padding-left:20px;line-height:1.95;color:#334155;font-size:13.5px;">' +
    arr.map(function (x) { return '<li style="margin-bottom:5px;">' + dpText(x) + '</li>'; }).join('') + '</ol>';
}

/* 键值网格：对象 */
function dpKV(o) {
  var keys = Object.keys(o).filter(function (k) {
    return META_KEYS.indexOf(k) < 0 && PROCESS_KEYS.indexOf(k) < 0 && TECH_KEYS.indexOf(k) < 0;
  });
  if (!keys.length) return '';
  return '<div style="display:grid;grid-template-columns:auto 1fr;gap:7px 16px;font-size:13px;line-height:1.8;">' +
    keys.map(function (k) {
      return '<div style="color:#334155;font-weight:600;white-space:nowrap;">' + pt(kLabel(k)) + '</div>' +
        '<div style="color:#334155;">' + dpCell(k, o[k]) + '</div>';
    }).join('') + '</div>';
}

/* 卡片：标题 + 正文 + 脚注 */
function dpCard(idx, title, val) {
  if (val === null || val === undefined) return '';
  var body;
  if (Array.isArray(val)) {
    if (!val.length) body = '<div style="color:#94a3b8;">（空）</div>';
    else if (typeof val[0] === 'object' && val[0] !== null) body = dpTable(val.map(dpStrip));
    else body = dpList(val);
  } else if (typeof val === 'object') {
    body = dpKV(dpStrip(val));
  } else {
    body = '<div style="font-size:13.5px;line-height:1.9;color:#334155;">' + dpText(val) + '</div>';
  }
  if (!body) return '';
  return '<div id="dpc_' + idx + '" style="margin-bottom:14px;border:1px solid #e2e8f0;border-radius:9px;overflow:hidden;">' +
    '<div style="padding:9px 14px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-weight:700;' +
    'font-size:13.5px;color:#1e293b;">' + pt(kLabel(title)) + '</div>' +
    '<div style="padding:13px 14px;">' + body + '</div>' +
    (typeof val === 'object' && !Array.isArray(val) ? dpMetaLine(val) : '') +
    '</div>';
}

/* ==========================================================================
 * 行业总表（V12.3 起并入「数据看板」顶部视图切换，见 app.js 的 boardTableHtml）
 * 这里只留跳板 + 表格渲染，供数据看板复用。
 * ========================================================================== */
function pageIndBoard(c) {
  /* V12.3：本页主体已并入「数据看板」的「行业总表」视图（见 app.js 的 boardTableHtml）。
     这里只保留一个跳板 —— 旧链接 / 旧脚本仍能用，渲染出来就是行业总表。 */
  if (typeof S !== 'undefined') { S.dashView = 'table'; }
  return (typeof pageDashboard === 'function') ? pageDashboard(c) : '';
}

/* 只重绘表格区 —— 不整页重渲染，所以输入框不会丢焦点 */
function brdFilter(k, v) {
  BOARD_FILTER[k] = v;
  const body = document.getElementById('brdBody');
  const list = profList().filter(p => p.isIndustry);
  if (body) body.innerHTML = brdRows(list);
}

function brdReset() {
  BOARD_FILTER = { tier: 'all', cat: 'all', q: '' };
  if (typeof S !== 'undefined') S.dashView = 'table';
  go('dashboard');
}

function brdRows(list) {
  const T = window.XWK_TAXO;
  const f = BOARD_FILTER;
  const q = (f.q || '').trim().toLowerCase();
  let shown = list.filter(p => {
    if (f.tier !== 'all' && p.tier !== f.tier) return false;
    if (f.cat !== 'all' && p.cat !== f.cat) return false;
    if (q) {
      const hay = (p.code + ' ' + p.name + ' ' + p.cat + ' ' + (p.base['典型经营主体形态'] || '')).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
  shown.sort((a, b) => (a.tier + a.code).localeCompare(b.tier + b.code));

  if (!shown.length) {
    return '<div class="empty" style="padding:36px 20px;">没找到「' + esc(f.q || '') + '」相关的行业，换个词试试（如：餐饮、零售、制造、物流）。</div>';
  }

  const TH = 'padding:10px 12px;background:#f8fafc;border-bottom:2px solid #e2e8f0;color:#334155;font-size:12.5px;white-space:nowrap;text-align:left;';
  const TD = 'padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;vertical-align:middle;';

  let h = '<div style="padding:10px 14px;color:#64748b;font-size:12.5px;border-bottom:1px solid #f1f5f9;">' +
    '命中 <b style="color:#1e293b;">' + shown.length + '</b> 个行业' +
    (f.tier !== 'all' ? ' ／ 常用程度 ' + esc(f.tier) : '') + (f.cat !== 'all' ? ' ／ 门类 ' + esc(f.cat) : '') +
    (q ? ' ／ 关键词「' + esc(f.q) + '」' : '') + '</div>';

  h += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;">' +
    '<tr>' +
    '<th style="' + TH + '">行业</th><th style="' + TH + '">门类</th><th style="' + TH + '">常见程度</th>' +
    '<th style="' + TH + '">毛利率</th><th style="' + TH + '">净利率</th>' +
    '<th style="' + TH + '">风险</th><th style="' + TH + '">交叉验证</th><th style="' + TH + '">城市基准</th><th style="' + TH + '"></th>' +
    '</tr>';

  shown.forEach((p, i) => {
    const gp = (p.kpi && p.kpi.毛利率区间) || '—';
    const np = (p.kpi && p.kpi.净利率区间) || '—';
    const studiedN = (p.dossier && p.dossier.H_城市差异)
      ? Object.keys(studiedCities(p.dossier.H_城市差异)).length : 0;
    h += '<tr style="' + (i % 2 ? 'background:#fcfdfe;' : '') + '">' +
      '<td style="' + TD + 'font-weight:600;white-space:nowrap;">' +
      '<a href="javascript:;" style="color:#1d4ed8;text-decoration:none;border-bottom:1px dashed #93c5fd;" ' +
      'title="在「数据看板」里看这个行业在所选城市的明细" ' +
      'onclick="openDashboard(\'' + esc(p.code) + '\')">' + esc(p.name) + '</a>' +
      '<span style="color:#94a3b8;font-weight:400;font-size:11.5px;margin-left:6px;">' + esc(p.code) + '</span></td>' +
      '<td style="' + TD + 'color:#334155;white-space:nowrap;">' + esc(p.cat) + '</td>' +
      '<td style="' + TD + 'white-space:nowrap;">' + T.tierBadge(p.tier) +
      (p.depth ? ' ' + T.depthBadge(p.depth) : '') + '</td>' +
      '<td style="' + TD + 'white-space:nowrap;color:#0f766e;font-weight:600;">' + esc(gp) + '</td>' +
      '<td style="' + TD + 'white-space:nowrap;color:#0f766e;font-weight:600;">' + esc(np) + '</td>' +
      '<td style="' + TD + 'white-space:nowrap;">' + T.riskBadge(p.risk.level) +
      (p.risk.scoreAvg !== null && p.risk.scoreAvg !== undefined ? '<span style="color:#94a3b8;font-size:11.5px;margin-left:5px;">' + p.risk.scoreAvg + '分</span>' : '') + '</td>' +
      '<td style="' + TD + 'white-space:nowrap;color:#334155;">' + (p.hooks.length ? p.hooks.length + ' 项' : '<span style="color:#94a3b8;">—</span>') + '</td>' +
      '<td style="' + TD + 'white-space:nowrap;">' +
      '<button class="btn" style="padding:4px 11px;font-size:12px;" onclick="openDossier(\'' + esc(p.code) + '\',\'H\')">' +
      (studiedN ? studiedN + ' 城已调研' : '23 城基准') + '</button></td>' +
      '<td style="' + TD + 'white-space:nowrap;"><button class="btn btn-primary" style="padding:4px 12px;font-size:12px;" onclick="openDossier(\'' + esc(p.code) + '\')">交叉验证</button></td>' +
      '</tr>';
  });
  return h + '</table></div>';
}

/* ==========================================================================
 * 页面二：小微行业交叉验证看板
 * ========================================================================== */
function pageDeepDossier(c) {
  const T = window.XWK_TAXO;
  const list = profList().filter(p => p.dossier);
  const st = profStats() || {};

  let h = '<div class="page-head"><div>' +
    '<div class="page-title">小微行业交叉验证看板</div>' +
    '<div class="page-sub">' + (st.dossierCount || 0) + ' 个行业已建档 ｜ 交叉验证 ' + (st.hookCount || 0) + ' 项 ｜ ' +
    '用第三方硬证据反推客户自述数据，对不上的直接标红。</div></div></div>';

  if (!list.length) {
    h += '<div class="section-card"><div class="empty">暂无档案数据。</div></div>';
    return h;
  }

  const cats = Array.from(new Set(list.map(p => p.cat))).sort();
  const cnt = t => list.filter(p => p.tier === t).length;

  h += '<div class="section-card">' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">' +
    '<div style="flex:1 1 240px;min-width:200px;">' +
    '<div style="font-size:12px;color:#334155;font-weight:600;margin-bottom:4px;">搜行业（编号 / 行业名）</div>' +
    '<input id="dosf_q" class="input" style="width:100%;padding:9px 12px;font-size:14px;" placeholder="例如：火锅、LS13" ' +
    'value="' + esc(DOS_FILTER.q) + '" oninput="dosFilter(\'q\',this.value)" autocomplete="off" /></div>' +
    '<div><div style="font-size:12px;color:#334155;font-weight:600;margin-bottom:4px;">常用程度</div>' +
    '<select id="dosf_tier" class="input" style="min-width:150px;padding:8px 10px;" onchange="dosFilter(\'tier\',this.value)">' +
    [['all', '全部（' + list.length + '）'], ['P0', '常见（' + cnt('P0') + '）'], ['P1', '较常见（' + cnt('P1') + '）'], ['P2', '少见（' + cnt('P2') + '）']]
      .map(o => '<option value="' + o[0] + '"' + (DOS_FILTER.tier === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
    '</select></div>' +
    '<div><div style="font-size:12px;color:#334155;font-weight:600;margin-bottom:4px;">行业门类</div>' +
    '<select id="dosf_cat" class="input" style="min-width:170px;padding:8px 10px;" onchange="dosFilter(\'cat\',this.value)">' +
    [['all', '全部']].concat(cats.map(x => [x, x])).map(o => '<option value="' + esc(o[0]) + '"' + (DOS_FILTER.cat === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
    '</select></div>' +
    '<button class="btn" style="padding:8px 14px;" onclick="dosFilterReset()">清空</button>' +
    '</div>' +
    '<div id="dosList" style="margin-top:12px;">' + dosChips(list) + '</div></div>';

  const code = (S.dossierCode && prof(S.dossierCode) && prof(S.dossierCode).dossier) ? S.dossierCode : (list[0] ? list[0].code : null);
  if (!code) { h += '<div class="section-card"><div class="empty">无可用档案。</div></div>'; return h; }
  S.dossierCode = code;
  const p = prof(code);
  const d = p.dossier;

  /* --- 概览：四个大数字 + 一行小字 --- */
  const big = [['毛利率', p.kpi.毛利率区间], ['净利率', p.kpi.净利率区间],
    ['风险层级', T.riskBadge(p.risk.level) + (p.risk.scoreAvg === null ? '' : '<span style="color:#94a3b8;font-size:12px;font-weight:400;margin-left:4px;">' + p.risk.scoreAvg + ' 分</span>')],
    ['交叉验证', p.hooks.length + '<span style="font-size:12px;color:#64748b;font-weight:400;"> 项</span>']];
  h += '<div class="section-card">' +
    '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px;">' +
    '<div style="font-size:19px;font-weight:700;color:#0f172a;">' + esc(p.name) + '</div>' +
    '<span style="color:#94a3b8;font-size:13px;">' + esc(code) + '</span>' + T.tierBadge(p.tier) + T.depthBadge(p.depth) + '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;">' +
    big.map(b => '<div style="background:#f0fdfa;border:1px solid #ccfbf1;border-radius:9px;padding:12px 14px;">' +
      '<div style="color:#115e59;font-size:11.5px;font-weight:600;">' + esc(b[0]) + '</div>' +
      '<div style="font-weight:700;font-size:18px;margin-top:5px;color:#0f766e;">' + b[1] + '</div></div>').join('') +
    '</div>' +
    '<div style="margin-top:11px;color:#64748b;font-size:12px;line-height:1.8;">' +
    '行业门类 ' + esc(p.cat) + '　｜　数据细致度 ' + esc(T.DEPTH_META[p.depth].label) +
    '　｜　核验日期 ' + esc(p.verifiedAt || '—') + '　｜　数据单元 ' + p.units +
    '</div></div>';

  /* --- 交叉验证引擎：核心工具，置顶 --- */
  S.xe = S.xe || {};
  /* F2 六维证据矩阵：先看清六个维度各自覆盖到什么程度，再看具体钩子 */
  if (XWK_ENGINE && XWK_ENGINE.sixHtml) h += XWK_ENGINE.sixHtml(p);
  h += XWK_ENGINE.renderHtml(p, S.xe[code]);

  /* --- 档案明细：分组 Tab + 组内目录 + 卡片 --- */
  /* 城市差异组即使本行业没做过城市级研究，也有城市基准表可用，所以恒为可点 */
  const has = f => (d[f] && Object.keys(d[f]).length) || (f === 'H_城市差异' && Object.keys(cityFactors()).length);
  const avail = DOS_GROUPS.filter(g => has(g.f));
  if (!avail.some(g => g.k === DOS_TAB)) DOS_TAB = avail.length ? avail[0].k : 'A';

  h += '<div class="section-card"><div class="section-title">📖 详细档案</div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #e2e8f0;padding-bottom:10px;margin-bottom:6px;">' +
    DOS_GROUPS.map(g => '<button class="btn ' + (DOS_TAB === g.k ? 'btn-primary' : '') + '" style="padding:5px 12px;font-size:12px;' + (has(g.f) ? '' : 'opacity:.35;') + '" ' +
      'title="' + esc(g.d) + '" onclick="dosTab(\'' + g.k + '\')">' + esc(g.t) + '</button>').join('') +
    '</div>' +
    '<div id="dosTabDesc" style="color:#64748b;font-size:12.5px;padding:6px 2px 10px;">' + esc((DOS_GROUPS.filter(g => g.k === DOS_TAB)[0] || {}).d || '') + '</div>' +
    '<div id="dosTabBody">' + dosRenderTab(d, DOS_TAB) + '</div></div>';

  setTimeout(xeBind, 0);
  return h;
}

/* 只重绘行业标签区 —— 不整页重渲染，输入焦点不丢 */
function dosFilter(k, v) {
  DOS_FILTER[k] = v;
  const box = document.getElementById('dosList');
  if (box) box.innerHTML = dosChips(profList().filter(p => p.dossier));
}
function dosFilterReset() { DOS_FILTER = { tier: 'all', cat: 'all', q: '' }; go('deep-dossier'); }

function dosChips(list) {
  const T = window.XWK_TAXO;
  const f = DOS_FILTER;
  const q = (f.q || '').trim().toLowerCase();
  let shown = list.filter(p => {
    if (f.tier !== 'all' && p.tier !== f.tier) return false;
    if (f.cat !== 'all' && p.cat !== f.cat) return false;
    if (q && (p.code + ' ' + p.name + ' ' + p.cat).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  shown.sort((a, b) => (a.tier + a.code).localeCompare(b.tier + b.code));
  if (!shown.length) {
    return '<div style="color:#64748b;font-size:12.5px;padding:6px 2px;">没找到「' + esc(f.q || '') + '」。</div>' +
      '<div style="margin-top:6px;"><button class="btn" style="padding:5px 11px;font-size:12px;" onclick="dosShowAll()">显示全部 ' + list.length + ' 个</button></div>';
  }
  const filtered = !!q || f.tier !== 'all' || f.cat !== 'all';
  return '<div style="display:flex;gap:6px;flex-wrap:wrap;max-height:190px;overflow:auto;">' +
    shown.map(p => '<button class="btn ' + (S.dossierCode === p.code ? 'btn-primary' : '') + '" style="padding:5px 11px;font-size:12px;" onclick="openDossier(\'' + esc(p.code) + '\')">' + esc(p.name) + ' ' + T.depthBadge(p.depth) + '</button>').join('') +
    '</div><div style="margin-top:8px;color:#64748b;font-size:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
    '<span>命中 <b>' + shown.length + '</b> 个 ／ 共 ' + list.length + ' 个</span>' +
    (filtered ? '<button class="btn" style="padding:3px 10px;font-size:12px;" onclick="dosShowAll()">显示全部</button>' : '') +
    '</div>';
}

/* 组内渲染：先给目录，再给卡片 */
function dosRenderTab(d, tab) {
  const g = DOS_GROUPS.filter(x => x.k === tab)[0];
  if (!g) return '';
  CUR_VAR_MAP = dpBuildVarMap(prof(S.dossierCode));
  const v = d[g.f];

  /* 城市差异组：即使这个行业没做过城市级调研，也给出城市层面的可用基准 */
  if (tab === 'H') return dosRenderCity(v);

  if (!v || !Object.keys(v).length) {
    return '<div class="empty-sm">这一组本行业暂未收录，先留着 —— 有核实过的内容才写，不拼凑。</div>';
  }
  const subs = Object.keys(v).filter(k => META_KEYS.indexOf(k) < 0 && PROCESS_KEYS.indexOf(k) < 0);
  if (!subs.length) return '<div class="empty-sm">这一组本行业暂未收录。</div>';

  /* 组内目录：一眼看出这一组都讲了什么 */
  let h = '<div style="display:flex;gap:6px;flex-wrap:wrap;padding:2px 0 14px;">' +
    subs.map((k, i) => '<button class="btn" style="padding:4px 10px;font-size:12px;" onclick="dosGo(\'dpc_' + i + '\')">' + pt(kLabel(k)) + '</button>').join('') +
    '</div>';

  h += subs.map((k, i) => dpCard(i, k, dosVal(k, v[k]))).join('');
  return h;
}

/* 面向用户的文案替换：数据原样留在库里备查，页面只说人话 */
function dosVal(k, val) {
  if (k === '待补说明') return CITY_PENDING_NOTE;
  if (k === '待补城市' && Array.isArray(val)) {
    if (!val.length) return '';
    return '这些城市还没有做过本行业的实地调研：' + val.join('、') + '。' +
      '下面「各城市成本与风险」表里已经给了它们的换算基准与风险分，' +
      '可以直接用来估算和议价；要落地判断，仍以现场询价与尽调为准。';
  }
  return val;
}

/* ==========================================================================
 * 城市差异组
 * --------------------------------------------------------------------------
 * 行业×城市只在少数城市做过独立研究，其余城市不编结论。
 * 但「城市」这一层的租金 / 人工 / 消费力是已经核实过的（与「城市分析」
 * 「城市风控」同一份城市库数据），可以用来把行业基准换算到当地。
 * ========================================================================== */
const CITY_PENDING_NOTE = '这些城市还没有做过本行业的实地调研，所以这里不硬编「某行业在某城市怎么样」的结论 —— ' +
  '需要当地判断时，用下面「各城市成本与风险」那张表：每个城市的房租占比、人工占比、风险分都是' +
  '按当地系数算出来的，可以直接拿来估算与议价，最终仍以现场询价和尽调为准。';

function cityFactors() {
  return (typeof DB !== 'undefined' && DB.city_factors) ? DB.city_factors : {};
}

/* 从成本结构里挑出「房租」或「人工」这一项（混合科目不参与换算） */
function costItem(cs, kind) {
  let arr = [];
  if (Array.isArray(cs)) arr = cs;
  else if (cs && typeof cs === 'object' && Array.isArray(cs['值'])) arr = cs['值'];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (!it || typeof it !== 'object') continue;
    const name = String(it['科目'] || it['项目'] || '');
    const ratio = it['占营收比'] || it['占比'] || '';
    if (!name || !ratio) continue;
    const core = name.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');
    let hit = false;
    if (kind === 'rent') hit = /房租|租金|铺租/.test(core) && !/[、，,与及或/]/.test(core);
    else hit = /人工|人力|薪酬|工资/.test(core) && !/[、，,与及或/]/.test(core);
    if (!hit) continue;
    const r = (typeof XWK_PROFILE !== 'undefined' && XWK_PROFILE.pctRange) ? XWK_PROFILE.pctRange(ratio) : null;
    if (r) return { 名称: name, 占比: ratio, lo: r.lo, hi: r.hi };
  }
  return null;
}

/* 已做过独立研究的城市（H 组「城市档案」里的） */
function studiedCities(v) {
  const set = {};
  const cf = cityFactors();
  const ca = v && v['城市档案'];
  if (Array.isArray(ca)) ca.forEach(x => { if (x && x['城市']) set[x['城市']] = 1; });
  else if (ca && typeof ca === 'object') Object.keys(ca).forEach(k => { if (cf[k]) set[k] = 1; });
  return set;
}

function cityRatioCell(item, k) {
  if (!item) return '';
  const lo = item.lo * k, hi = item.hi * k;
  const color = k >= 1.5 ? '#b91c1c' : k <= 0.7 ? '#1d4ed8' : '#334155';
  const bg = k >= 1.5 ? '#fef2f2' : k <= 0.7 ? '#eff6ff' : 'transparent';
  return '<span style="color:' + color + ';font-weight:600;background:' + bg + ';padding:1px 6px;border-radius:4px;">' +
    lo.toFixed(1) + '% ~ ' + hi.toFixed(1) + '%</span>';
}

/* 行业 × 城市矩阵表 —— 全站城市展示的唯一来源
 * 每一行都是算出来的：城市系数（已核实）× 本行业成本基准（已核实）。
 * 与「数据看板 · 城市风险分级」「城市分析」「城市风控」同一份数据、同一个算法。 */
function cityBenchHtml(p) {
  const M = (typeof XWK_PROFILE !== 'undefined' && XWK_PROFILE.cityMatrix) ? XWK_PROFILE.cityMatrix(p, DB, null) : null;
  if (!M || !M.rows.length) return '';

  const rows = M.rows.slice().sort((a, b) => (b.风险评分 || 0) - (a.风险评分 || 0));
  const b = M.basis;
  const studied = studiedCities(p && p.dossier ? p.dossier.H_城市差异 : null);
  const studiedN = Object.keys(studied).length;

  const TH = 'padding:9px 11px;background:#f8fafc;border-bottom:2px solid #e2e8f0;color:#334155;font-size:12.5px;white-space:nowrap;text-align:left;position:sticky;top:0;';
  const TD = 'padding:8px 11px;border-bottom:1px solid #f1f5f9;font-size:13px;white-space:nowrap;';
  const kc = v => v >= 1.5 ? '#b91c1c' : v <= 0.7 ? '#1d4ed8' : '#334155';

  const T = window.XWK_TAXO;

  /* 顶部：口径说明（不附加"已查证/非模板"自证） */
  let h = '<div style="margin:0 0 14px;padding:12px 14px;background:#f8fafc;border-left:3px solid #94a3b8;' +
    'border-radius:0 6px 6px 0;color:#334155;font-size:12.5px;line-height:1.85;">' +
    '城市这一层的租金 / 人工 / 消费力是核实过的城市库数据；' +
    '本行业的成本基准取自本档案的单产与成本。两者相乘，得到每个城市当地的房租占比、人工占比与风险分。' +
    (studiedN ? '<br>其中 <b style="color:#15803d;">' + studiedN + ' 个城市</b>还做过本行业的实地调研（表中标「已调研」），' +
      '那些城市另有一节逐城结论，比换算值更细，以那节为准。' : '') +
    '</div>';

  /* 换算用到的行业基准，明写出来 */
  h += '<div style="margin-bottom:10px;color:#334155;font-size:12.5px;line-height:1.8;">换算用的本行业基准：';
  if (b.has) {
    const seg = [];
    if (b.rent) seg.push('<b style="color:#0f766e;">' + esc(b.rent.名称) + ' ' + esc(b.rent.占比) + '</b>');
    if (b.labor) seg.push('<b style="color:#0f766e;">' + esc(b.labor.名称) + ' ' + esc(b.labor.占比) + '</b>');
    h += seg.join('　｜　');
  } else {
    h += '本档案成本结构里没有单列的房租 / 人工科目，因此只给城市系数与风险分，不做占比换算。';
  }
  h += '</div>';

  /* 本行业最吃哪个城市要素 —— 没有实地调研也能给出的判断，由成本结构直接决定 */
  const sens = citySensitivity(b);
  if (sens) {
    h += '<div style="margin-bottom:12px;padding:11px 14px;background:#fffbeb;border:1px solid #fde68a;' +
      'border-radius:7px;color:#78350f;font-size:12.5px;line-height:1.85;">' +
      '<b>本行业最该盯的城市要素：' + sens.title + '</b><br>' + esc(sens.text) + '</div>';
  }

  const COLS = [];
  COLS.push(['城市', 1]); COLS.push(['城市定位', 1]); COLS.push(['产业匹配', 1]);
  COLS.push(['商铺租金', 1]); COLS.push(['综合成本', 1]); COLS.push(['人工薪资', 1]); COLS.push(['薪资购买力', 1]);
  if (b.rent) COLS.push(['当地房租占营收', 1]);
  if (b.labor) COLS.push(['当地人工占营收', 1]);
  if (b.rent && b.labor) COLS.push(['房租+人工合计', 1]);
  COLS.push(['城市风险分', 1]); COLS.push(['层级', 1]);

  h += '<div style="max-height:460px;overflow:auto;border:1px solid #e2e8f0;border-radius:8px;">' +
    '<table style="width:100%;border-collapse:collapse;"><tr>' +
    COLS.map(c => '<th style="' + TH + '">' + c[0] + '</th>').join('') + '</tr>';

  rows.forEach((r, i) => {
    h += '<tr style="' + (i % 2 ? 'background:#fcfdfe;' : '') + '">' +
      '<td style="' + TD + 'font-weight:600;">' + esc(r.城市) +
      (studied[r.城市] ? '<span style="margin-left:6px;padding:1px 6px;border-radius:4px;background:#dcfce7;color:#15803d;font-size:11px;">已调研</span>' : '') +
      '</td>' +
      '<td style="' + TD + 'color:#64748b;white-space:normal;min-width:170px;">' + esc(r.定位 || '—') + '</td>' +
      '<td style="' + TD + '">' + matchCell(r.产业匹配) + '</td>' +
      '<td style="' + TD + 'color:' + kc(r.租金倍数) + ';font-weight:600;">' +
      r.租金系数.toFixed(2) + '<span style="color:#94a3b8;font-weight:400;margin-left:4px;">×' + r.租金倍数.toFixed(2) + '</span></td>' +
      '<td style="' + TD + '">' + (r.成本系数 != null ? r.成本系数.toFixed(2) : '—') + '</td>' +
      '<td style="' + TD + 'color:' + kc(r.薪资倍数) + ';font-weight:600;">' +
      r.薪资系数.toFixed(2) + '<span style="color:#94a3b8;font-weight:400;margin-left:4px;">×' + r.薪资倍数.toFixed(2) + '</span></td>' +
      '<td style="' + TD + '">' + (r.购买力 != null ? r.购买力.toFixed(2) : '—') + '</td>' +
      (b.rent ? '<td style="' + TD + '">' + cityRatioCell(b.rent, r.租金倍数) + '</td>' : '') +
      (b.labor ? '<td style="' + TD + '">' + cityRatioCell(b.labor, r.薪资倍数) + '</td>' : '') +
      (b.rent && b.labor ? '<td style="' + TD + 'font-weight:700;color:#b45309;">' + r.固定成本合计.toFixed(1) + '%</td>' : '') +
      '<td style="' + TD + 'font-weight:700;">' + (r.风险评分 == null ? '—' :
        r.风险评分.toFixed(1) + '<span style="color:#94a3b8;font-weight:400;margin-left:4px;">' + (r.成本加减分 >= 0 ? '+' : '') + r.成本加减分 + '</span>') + '</td>' +
      '<td style="' + TD + '">' + (r.风险评分 == null ? '—' : T.riskBadge(r.风险层级)) + '</td>' +
      '</tr>';
  });

  h += '</table></div>';

  /* 三个一眼能记住的结论 */
  if (M.worst && M.best) {
    h += '<div style="margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;">' +
      '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:9px;padding:11px 13px;">' +
      '<div style="color:#b91c1c;font-size:11.5px;font-weight:600;">成本压力最大的城市</div>' +
      '<div style="font-weight:700;font-size:16px;margin-top:4px;color:#991b1b;">' + esc(M.worst.城市) + ' ' + M.worst.风险评分.toFixed(1) + ' 分</div>' +
      '<div style="color:#64748b;font-size:12px;margin-top:3px;">比中位城市成本高 ' + ((M.worst.成本指数 - 1) * 100).toFixed(0) + '%</div></div>' +
      '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:9px;padding:11px 13px;">' +
      '<div style="color:#1d4ed8;font-size:11.5px;font-weight:600;">成本压力最小的城市</div>' +
      '<div style="font-weight:700;font-size:16px;margin-top:4px;color:#1e40af;">' + esc(M.best.城市) + ' ' + M.best.风险评分.toFixed(1) + ' 分</div>' +
      '<div style="color:#64748b;font-size:12px;margin-top:3px;">比中位城市成本低 ' + ((1 - M.best.成本指数) * 100).toFixed(0) + '%</div></div>' +
      '<div style="background:#f0fdfa;border:1px solid #ccfbf1;border-radius:9px;padding:11px 13px;">' +
      '<div style="color:#115e59;font-size:11.5px;font-weight:600;">行业基准风险分</div>' +
      '<div style="font-weight:700;font-size:16px;margin-top:4px;color:#0f766e;">' + (M.baseScore == null ? '—' : M.baseScore.toFixed(1)) + ' 分</div>' +
      '<div style="color:#64748b;font-size:12px;margin-top:3px;">城市分在此之上加减</div></div>' +
      '</div>';
  }

  h += '<div style="margin-top:10px;color:#94a3b8;font-size:11.5px;line-height:1.85;">' +
    '口径：' + esc(M.formula) + '。' +
    '系数以 ' + M.total + ' 城的中位城市 = 1.00 为基准；薪资购买力 = 人工薪资系数 ÷ 综合成本系数；' +
    '房租 / 人工占比 = 本行业基准 × 当地系数 ÷ 中位城市系数。' +
    '<span style="color:#b91c1c;">红色</span>＝高出中位城市 50% 以上，<span style="color:#1d4ed8;">蓝色</span>＝低于 30% 以上，' +
    '这两类城市现场必须用当地实际租金与工资重新校准。' +
    '<br>「产业匹配」是按城市产业定位关键词与本行业名称的自动比对，只作参考，不作为准入或否决依据。</div>';
  return h;
}

/* 本行业对哪个城市要素最敏感 —— 由成本结构里房租与人工的相对大小直接判定，
   不需要逐城调研，也不会因行业不同而套同一个模板 */
function citySensitivity(b) {
  if (!b || !b.has) return null;
  if (b.rent && b.labor) {
    const r = b.rent.mid, l = b.labor.mid;
    if (r > l * 1.15) return {
      title: '商铺租金',
      text: '房租占营收 ' + b.rent.占比 + '，高于人工的 ' + b.labor.占比 + '。选址决定生死 —— ' +
        '优先看「商铺租金」这一列，一线城市（租金系数 ×1.5 以上）会让房租占比直接翻倍，' +
        '现场必须拿到租赁合同与实际坪数核对，不能拿客户的口头租金。'
    };
    if (l > r * 1.15) return {
      title: '人工成本',
      text: '人工占营收 ' + b.labor.占比 + '，高于房租的 ' + b.rent.占比 + '。人是主要成本 —— ' +
        '优先看「人工薪资」这一列，一线城市薪资系数高出中位城市三成以上，' +
        '核验时以社保缴纳人数与工资流水为准，不能只听客户报的人数。'
    };
    return {
      title: '房租与人工并重',
      text: '房租 ' + b.rent.占比 + '、人工 ' + b.labor.占比 + '，两项接近，合计约占营收 ' +
        (b.rent.mid + b.labor.mid).toFixed(0) + '%。' +
        '优先看「房租+人工合计」这一列，两项叠加后的固定成本压力才是这个行业跨城市的主要变量。'
    };
  }
  if (b.rent) return {
    title: '商铺租金',
    text: '成本结构中单列了房租 ' + b.rent.占比 + '，租金是这个行业跨城市差异最大的一项，' +
      '优先看「商铺租金」列，一线城市需按当地水平重新校准。'
  };
  return {
    title: '人工成本',
    text: '成本结构中单列了人工 ' + b.labor.占比 + '，工资水平是这个行业跨城市差异最大的一项，' +
      '优先看「人工薪资」列，核验以社保人数与工资流水为准。'
  };
}

/* 产业匹配徽标 */
function matchCell(m) {
  if (!m || !m.lv) return '—';
  const style = {
    '产业相关': 'background:#dcfce7;color:#15803d;',
    '大类相关': 'background:#fef3c7;color:#a16207;',
    '无直接对应': 'background:#f1f5f9;color:#64748b;'
  }[m.lv] || 'background:#f1f5f9;color:#64748b;';
  const tip = m.hits && m.hits.length ? '命中：' + m.hits.join('、') : '该城市主导产业中未列出本行业';
  return '<span style="' + style + 'padding:2px 7px;border-radius:4px;font-size:11.5px;font-weight:600;" title="' + esc(tip) + '">' + esc(m.lv) + '</span>';
}

function dosRenderCity(v) {
  const p = prof(S.dossierCode);
  let h = '';
  const hasCity = v && Object.keys(v).length;

  if (hasCity) {
    const subs = Object.keys(v).filter(k => META_KEYS.indexOf(k) < 0 && PROCESS_KEYS.indexOf(k) < 0 && TECH_KEYS.indexOf(k) < 0);
    if (subs.length) {
      h += '<div style="display:flex;gap:6px;flex-wrap:wrap;padding:2px 0 14px;">' +
        subs.map((k, i) => '<button class="btn" style="padding:4px 10px;font-size:12px;" onclick="dosGo(\'dpc_' + i + '\')">' + pt(kLabel(k)) + '</button>').join('') +
        '<button class="btn btn-primary" style="padding:4px 10px;font-size:12px;" onclick="dosGo(\'dpCityMatrix\')">各城市成本与风险</button>' +
        '</div>';
      h += subs.map((k, i) => dpCard(i, k, dosVal(k, v[k]))).join('');
    }
  }

  /* 城市矩阵：不管这个行业有没有做过实地调研，23 个城市的成本与风险都给全 */
  h += '<div id="dpCityMatrix" style="margin-top:' + (hasCity ? '18px' : '0') + ';">' +
    '<div style="font-size:14px;font-weight:700;color:#1e293b;margin-bottom:4px;">各城市成本与风险（全 ' +
    Object.keys(cityFactors()).length + ' 城）</div>' +
    '<div style="color:#64748b;font-size:12.5px;margin-bottom:12px;">' +
    '按当地租金 / 人工 / 成本系数，把本行业的成本基准换算到每个城市，再算出风险分。</div>' +
    cityBenchHtml(p) + '</div>';
  return h;
}

/* ==========================================================================
 * 交互
 * ========================================================================== */
/* 从看板点某个行业进来时，把行业编号直接填进搜索框 —— 列表只剩这一个行业，
   页面展示的就是你刚选的那个，而不是全量列表 */
function openDossier(code, tab) {
  S.dossierCode = code;
  DOS_TAB = tab || 'A';
  DOS_FILTER = { tier: 'all', cat: 'all', q: code };
  go('deep-dossier');
}

/* 从行业看板直接进数据看板：把这个行业带进去，不用再选一遍。
   动线的第 2 段 —— 看这个行业在所选城市怎么样。 */
function openDashboard(code) {
  const p = prof(code);
  if (!p) return;
  if (typeof S !== 'undefined' && S.dash) {
    S.dash.industry = p.name;
    S.dash.ci = new Set([code]);
    S.dash.cj = new Set();
    S.dash.queried = true;
    /* 从总表点进来的人要看的是这个行业的明细，不是总表 */
    S.dashView = 'work';
    S.dashTab = 'ov';
  }
  go('dashboard');
}

/* 看回全部行业 */
function dosShowAll() {
  DOS_FILTER = { tier: 'all', cat: 'all', q: '' };
  go('deep-dossier');
}

function dosTab(id) {
  DOS_TAB = id;
  const p = prof(S.dossierCode);
  if (p && p.dossier) {
    const body = document.getElementById('dosTabBody');
    if (body) body.innerHTML = dosRenderTab(p.dossier, id);
    const desc = document.getElementById('dosTabDesc');
    const g = DOS_GROUPS.filter(x => x.k === id)[0];
    if (desc && g) desc.textContent = g.d;
  }
  document.querySelectorAll('[onclick^="dosTab"]').forEach(function (b) {
    b.classList.toggle('btn-primary', b.getAttribute('onclick').indexOf("'" + id + "'") >= 0);
  });
}

function dosGo(id) {
  const el = document.getElementById(id);
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function xeBind() {
  const p = prof(S.dossierCode);
  if (!p) return;
  (XWK_ENGINE.inputsOf(p) || []).forEach(function (it) {
    const el = document.getElementById('xe_' + it.key);
    if (!el) return;
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter') xeRun(); });
  });
}
function xeRun() {
  const p = prof(S.dossierCode);
  if (!p) return;
  const vals = XWK_ENGINE.collectValues(p);
  const res = XWK_ENGINE.run(p, vals);
  const html = XWK_ENGINE.resultHtml(res);
  const r = document.getElementById('xeResult');
  if (r) r.innerHTML = html;
  S.xe = S.xe || {};
  S.xe[p.code] = Object.assign({}, vals, { resultHtml: html });
}
function xeClear() {
  const p = prof(S.dossierCode);
  if (!p) return;
  (XWK_ENGINE.inputsOf(p) || []).forEach(function (it) {
    const el = document.getElementById('xe_' + it.key);
    if (el && el.tagName === 'INPUT') el.value = '';
  });
  S.xe = S.xe || {};
  delete S.xe[p.code];
  const r = document.getElementById('xeResult');
  if (r) r.innerHTML = '';
}

/* ---------------- 注册到主程序 ---------------- */
(function () {
  try {
    PAGES['deep-dossier'] = pageDeepDossier;

    /* V12.3：ind-board 保留注册（旧链接 / 旧脚本仍可用，渲染出来就是行业总表），
       但不再进导航 —— 用户要求「把小微看板合并进数据看板」，
       行业总表现在是数据看板顶部的一个视图（S.dashView='table'），
       查到行业后由结果区分页往下钻。 */
    PAGES['ind-board'] = pageIndBoard;

    /* 「小微行业交叉验证看板」不再单独放进导航 —— 在数据看板里点行业即可直达。
       这里只把它的入口摘掉，页面本身保留（按钮跳转仍走它）。 */
    ['deep-dossier', 'ind-board', 'consistency', 'industries'].forEach(function (id) {
      for (var j = 0; j < NAV.length; j++) {
        if (NAV[j] && Array.isArray(NAV[j].items)) {
          NAV[j].items = NAV[j].items.filter(function (x) { return x.id !== id; });
        }
      }
      if (id === 'consistency' || id === 'industries') delete PAGE_TITLE[id];
    });

    /* 标题最后写 —— 早先写完再 delete，等于把自己的标题也删了，面包屑会显示成页面 id */
    PAGE_TITLE['ind-board'] = '行业总表（已并入数据看板）';
    PAGE_TITLE['deep-dossier'] = '小微行业交叉验证看板';
  } catch (e) {
    console.warn('行业看板页注册失败', e);
  }
})();
