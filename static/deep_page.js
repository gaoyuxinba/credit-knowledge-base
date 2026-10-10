/* ==========================================================================
 * 行业深度档案页 + 交叉验证计算器（V9.5）
 * --------------------------------------------------------------------------
 * 依赖：app.js 已加载（使用其 $ / esc / DB / PAGES / NAV / PAGE_TITLE）
 * 数据：DB.deepDossier（由 deep_dossier.js 解密后注入）
 *
 * 与既有页面的根本区别：
 *   既有 18 个页面都是"查询"型（我查一下）；
 *   本页面是"作业"型（我办一个案子）—— 输入现场数据，输出偏差与处置建议。
 * ========================================================================== */
'use strict';

/* ---------------- 店型参数（人效/翻台必须分档，单一基准会系统性误判） ---------------- */
var DOSSIER_STORE_TYPE = {
  '社区小店':   { turn: 2.0, eff: 1.5, area: '80~120㎡' },
  '标准商业店': { turn: 2.8, eff: 2.2, area: '150~300㎡' },
  '商圈/旗舰店': { turn: 2.5, eff: 2.8, area: '400㎡以上' },
};

/* ---------------- 小工具 ---------------- */
function dpNum(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}
function dpWan(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return (v / 10000).toFixed(1) + ' 万';
}
function dpPct(v, digits) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return (v * 100).toFixed(digits === undefined ? 1 : digits) + '%';
}
function dpLevelBadge(lv) {
  const map = { ok: ['✔ 正常', '#16a34a', '#dcfce7'], warn: ['⚠ 关注', '#d97706', '#fef3c7'], danger: ['✖ 红灯', '#dc2626', '#fee2e2'], na: ['— 未启用', '#94a3b8', '#f1f5f9'] };
  const m = map[lv] || map.na;
  return `<span style="display:inline-block;padding:2px 10px;border-radius:10px;background:${m[2]};color:${m[1]};font-size:12px;font-weight:600;">${m[0]}</span>`;
}
function dpDepthBadge(lv) {
  const c = { L0: '#94a3b8', L1: '#64748b', L2: '#0ea5e9', L3: '#8b5cf6', L4: '#16a34a' };
  const bg = { L0: '#f1f5f9', L1: '#f8fafc', L2: '#e0f2fe', L3: '#f5f3ff', L4: '#dcfce7' };
  return `<span style="display:inline-block;padding:1px 7px;border-radius:4px;background:${bg[lv] || '#f1f5f9'};color:${c[lv] || '#64748b'};font-size:11px;font-weight:700;">${lv || '—'}</span>`;
}
/* 递归渲染：把任意结构的数据块渲染成可读 HTML，并自动显示来源与置信度 */
function dpRenderBlock(o, depth) {
  depth = depth || 0;
  if (o === null || o === undefined) return '<span style="color:#94a3b8;">—</span>';
  if (typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean') return esc(String(o));
  if (Array.isArray(o)) {
    if (!o.length) return '<span style="color:#94a3b8;">（空）</span>';
    // 对象数组 → 表格
    if (typeof o[0] === 'object' && o[0] !== null) {
      const keys = [];
      o.forEach(x => Object.keys(x).forEach(k => { if (keys.indexOf(k) < 0) keys.push(k); }));
      const showKeys = keys.filter(k => k !== 'depth_level' && k !== 'source' && k !== 'confidence');
      let h = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;">';
      h += '<tr>' + showKeys.map(k => `<th style="text-align:left;padding:8px 10px;background:#f8fafc;border-bottom:2px solid #e2e8f0;color:#475569;white-space:nowrap;">${esc(k)}</th>`).join('') + '<th style="text-align:left;padding:8px 10px;background:#f8fafc;border-bottom:2px solid #e2e8f0;color:#475569;">深度</th></tr>';
      o.forEach((row, ri) => {
        h += '<tr style="' + (ri % 2 ? 'background:#fcfdfe;' : '') + '">';
        showKeys.forEach(k => {
          const v = row[k];
          const t = (typeof v === 'object' && v !== null) ? dpRenderBlock(v, depth + 1) : esc(String(v === undefined || v === null ? '—' : v));
          h += `<td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top;line-height:1.65;">${t}</td>`;
        });
        h += `<td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;">${dpDepthBadge(row.depth_level)}</td></tr>`;
        // 来源行
        if (row.source) {
          h += `<tr><td colspan="${showKeys.length + 1}" style="padding:4px 10px 10px 10px;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:11.5px;line-height:1.6;">📎 来源：${esc(row.source)}${row.confidence ? ' ｜ 置信度：' + esc(row.confidence) : ''}</td></tr>`;
        }
      });
      return h + '</table></div>';
    }
    return '<ul style="margin:0;padding-left:18px;line-height:1.9;">' + o.map(x => '<li>' + dpRenderBlock(x, depth + 1) + '</li>').join('') + '</ul>';
  }
  // 对象
  const keys = Object.keys(o);
  let h = '<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;line-height:1.7;">';
  keys.forEach(k => {
    if (k === 'depth_level' || k === 'source' || k === 'confidence' || k === 'author' || k === 'verified_at') return;
    h += `<div style="color:#475569;font-weight:600;white-space:nowrap;">${esc(k)}</div><div>${dpRenderBlock(o[k], depth + 1)}</div>`;
  });
  h += '</div>';
  if (o.source) {
    h += `<div style="margin-top:8px;padding:6px 10px;background:#f8fafc;border-left:3px solid #cbd5e1;border-radius:0 4px 4px 0;color:#64748b;font-size:11.5px;line-height:1.6;">📎 ${esc(o.source)}${o.confidence ? ' ｜ 置信度 ' + esc(o.confidence) : ''}${o.author ? ' ｜ ' + esc(o.author) : ''}${o.depth_level ? ' ｜ ' + o.depth_level : ''}</div>`;
  }
  return h;
}

/* ==========================================================================
 * 交叉验证引擎 —— 八钩子计算
 * 输入：{ storeType, area, tables, staff, revenue, power, sauce, rent, guest, payment }
 * 输出：结果数组 + 综合结论
 * ========================================================================== */
function deepCrossCheck(inp) {
  const T = DOSSIER_STORE_TYPE[inp.storeType] || DOSSIER_STORE_TYPE['标准商业店'];
  const R = [];
  const revenue = inp.revenue;
  const guest = inp.guest || 80;
  const 桌均消费 = guest * 4.5;              // 桌均人数 4.5
  const area = inp.area || 0;

  // 桌数推算区间
  const tbMid = area / 11.5, tbLow = area / 14, tbHigh = area / 10;
  const tbEff = inp.tables || tbMid;

  function dev(calc) { return (revenue - calc) / calc; }
  function lvl(d) {
    const a = Math.abs(d);
    if (a <= 0.20) return 'ok';
    if (a <= 0.40) return 'warn';
    return 'danger';
  }

  // ---- H1 面积 → 桌数 ----
  if (area) {
    const d = inp.tables ? (inp.tables - tbMid) / tbMid : null;
    R.push({
      id: 'H1', dim: '产能', name: '面积 → 桌数反推',
      calc: `${dpNum(tbLow)} ~ ${dpNum(tbHigh)} 张（中位 ${dpNum(tbMid)}）`,
      actual: inp.tables ? inp.tables + ' 张' : '未填',
      dev: d, level: d === null ? 'na' : (Math.abs(d) <= 0.20 ? 'ok' : Math.abs(d) <= 0.40 ? 'warn' : 'danger'),
      advice: d === null ? '未填桌数，已用面积推算值参与后续计算' :
        (d > 0.20 ? '自报桌数高于面积可容纳上限 → 虚报经营规模，须现场清点实际台位' :
          d < -0.20 ? '自报桌数远低于面积可容纳量 → 空间浪费或面积虚报，核实租赁合同面积' :
            '桌数与面积匹配'),
      basis: '桌均面积 10~14㎡（海底捞 11.5㎡）'
    });
  }

  // ---- H2 单产模型 ----
  if (area || inp.tables) {
    const revMid = tbEff * T.turn * 桌均消费 * 30;
    const revLow = tbLow * (T.turn * 0.75) * 桌均消费 * 30;
    const revHigh = tbHigh * (T.turn * 1.2) * 桌均消费 * 30;
    const d = dev(revMid);
    R.push({
      id: 'H2', dim: '产能', name: '单产模型反推营收',
      calc: `${dpWan(revLow)} ~ ${dpWan(revHigh)}（中位 ${dpWan(revMid)}）`,
      actual: dpWan(revenue),
      dev: d, level: lvl(d),
      advice: d > 0.40 ? '自述营收远超产能上限 → 营收虚增，重大疑点' :
        d > 0.20 ? '自述营收高于产能推算中位 20% 以上 → 追问翻台率与客单价真实性' :
          d < -0.40 ? '自述营收远低于产能推算 → 经营不佳或隐瞒收入，核实是否体外循环' :
            '营收与产能模型基本自洽',
      basis: `翻台 ${T.turn} 次/天（${inp.storeType}）｜桌均消费 ${dpNum(桌均消费)} 元｜营业 30 天`
    });
  }

  // ---- H3 人效 ----
  if (inp.staff) {
    const cap = inp.staff * T.eff * 10000;
    const d = dev(cap);
    R.push({
      id: 'H3', dim: '员工', name: '人效反推营收上限',
      calc: `${dpWan(cap)}（${inp.staff} 人 × ${T.eff} 万/人/月）`,
      actual: dpWan(revenue) + `（人效 ${dpWan(revenue / inp.staff)}/人）`,
      dev: d, level: lvl(d),
      advice: d > 0.20 ? '人效显著高于行业基准 → 少报用工（有未计入的兼职/外包）或营收虚高，四角核验用工人数' :
        d < -0.40 ? '人效远低于基准 → 人员冗余或营收不足，核实真实经营状况' :
          '人效在合理区间',
      basis: `人效基准 ${T.eff} 万/人/月（${inp.storeType}分档；全行业公开口径 1.2~2.8，须按店型取值）`
    });
  }

  // ---- H4 能耗 ----
  if (inp.power) {
    const openMid = inp.power / 10, openLow = inp.power / 12, openHigh = inp.power / 8;
    const revMid = openMid * 桌均消费, revLow = openLow * 桌均消费, revHigh = openHigh * 桌均消费;
    const d = dev(revMid);
    R.push({
      id: 'H4', dim: '产能', name: '能耗反推开台数',
      calc: `${dpWan(revLow)} ~ ${dpWan(revHigh)}（中位 ${dpWan(revMid)}）`,
      actual: dpWan(revenue),
      dev: d, level: lvl(d),
      advice: d > 0.40 ? '能耗推算营收远低于自述 → 能耗是硬约束，构成重大疑点，须现场抄表复核' :
        d > 0.20 ? '能耗推算低于自述 20% 以上 → 核实是否有分表、是否有其他用电回路' :
          '能耗与营收基本匹配（火锅能耗占营收 4%~8%，为最硬客观约束）',
      basis: `单桌电耗 8~12 度/桌/餐段｜推算月开台 ${dpNum(openLow)}~${dpNum(openHigh)} 次`
    });
  }

  // ---- H5 物料（最硬钩子） ----
  if (inp.sauce) {
    const openT = inp.sauce / 4.5;
    const rev = openT * 桌均消费;
    const d = dev(rev);
    R.push({
      id: 'H5', dim: '采购', name: '物料反推开台数（最硬钩子）',
      calc: `${dpWan(rev)}（开台 ${dpNum(openT)} 次）`,
      actual: dpWan(revenue),
      dev: d, level: lvl(d),
      advice: d > 0.40 ? '物料消耗反推远低于自述 → 采购台账难造假，构成强反证' :
        d > 0.20 ? '物料反推偏低 → 核实是否有外带、团餐等不占用蘸料的情形' :
          '物料消耗与营收勾稽一致，可信度高',
      basis: '油碟/一次性餐具消耗量 ÷ 桌均人数 4.5 = 开台数'
    });
  }

  // ---- H6 房租占比 ----
  if (inp.rent && revenue) {
    const ratio = inp.rent / revenue;
    R.push({
      id: 'H6', dim: '成本', name: '房租占比校验',
      calc: '健康 ≤15%，危险线 20%',
      actual: dpPct(ratio),
      dev: null,
      level: ratio > 0.20 ? 'danger' : ratio > 0.15 ? 'warn' : 'ok',
      advice: ratio > 0.20 ? '房租占比突破 20% 危险线 → 固定成本过重，是本行业第一大失败原因' :
        ratio > 0.15 ? '房租占比偏高 → 关注租约到期与涨租风险（核心商圈年涨 5%~8%）' :
          '房租占比健康',
      basis: '火锅房租占营收 8%~15%；一线核心商圈（如北京）须单独校验'
    });
  }

  // ---- H7 净利与 DSCR ----
  if (revenue) {
    const net = revenue * 0.08;
    let extra = '';
    let lv = 'ok', advice = '推算月净利可覆盖月供';
    if (inp.payment && inp.payment > 0) {
      const dscr = net / inp.payment;
      extra = `｜DSCR ${dscr.toFixed(2)}`;
      lv = dscr < 1.2 ? 'danger' : dscr < 1.5 ? 'warn' : 'ok';
      advice = dscr < 1.2 ? 'DSCR 低于 1.2 红线 → 现金流覆盖不足，应压缩额度或增加担保' :
        dscr < 1.5 ? 'DSCR 偏紧 → 建议压缩额度 20% 或追加担保' : '现金流覆盖充足';
    }
    R.push({
      id: 'H7', dim: '利润', name: '净利倒推与现金流覆盖',
      calc: `${dpWan(net)}（净利率中位 8%）${extra}`,
      actual: inp.payment ? '月供 ' + dpWan(inp.payment) : '未填月供',
      dev: null, level: inp.payment ? lv : 'na',
      advice: inp.payment ? advice : '填入月供后可计算 DSCR 覆盖倍数',
      basis: '火锅净利率 3%~18%（中位按 8%）；DSCR ≥1.2 为通行授信底线'
    });
  }

  // ---- H8 保本线 ----
  if (revenue) {
    const energy = revenue * 0.06;
    const amort = (area * 3000) / 36;
    const fixed = (inp.rent || 0) + (inp.staff || 0) * 4500 + energy + amort;
    const be = fixed / 0.60;
    const lv = revenue < be ? 'danger' : revenue < be * 1.2 ? 'warn' : 'ok';
    R.push({
      id: 'H8', dim: '成本', name: '保本线校验',
      calc: `保本月营收 ${dpWan(be)}（固定成本 ${dpWan(fixed)} ÷ 毛利率 60%）`,
      actual: dpWan(revenue),
      dev: null, level: lv,
      advice: revenue < be ? '自述营收低于保本线却声称盈利 → 直接矛盾，须重新核实成本' :
        revenue < be * 1.2 ? '营收仅略高于保本线 → 抗风险能力弱，淡季易亏损' :
          '营收显著高于保本线，安全边际充足',
      basis: `房租 ${dpWan(inp.rent || 0)} + 人工 ${dpWan((inp.staff || 0) * 4500)} + 能耗 ${dpWan(energy)} + 摊销 ${dpWan(amort)}`
    });
  }

  // ---- 综合结论 ----
  const danger = R.filter(x => x.level === 'danger').length;
  const warn = R.filter(x => x.level === 'warn').length;
  const ok = R.filter(x => x.level === 'ok').length;

  // 方向冲突检测：有的钩子认为自述偏高、有的认为偏低 → 证据之间互相打架
  const devs = R.filter(x => x.dev !== null && x.dev !== undefined);
  const up = devs.filter(x => x.dev > 0.20).length;     // 自述高于推算
  const down = devs.filter(x => x.dev < -0.20).length;  // 自述低于推算
  const conflict = up > 0 && down > 0;
  let conflictNote = '';
  if (conflict) {
    conflictNote = ` ⚠ 特别注意：${up} 项证据显示自述偏高、${down} 项显示偏低 —— 各项客观证据之间互相矛盾，说明这套自述数据整体不自洽，不是某一项算错，而是数据本身对不上。此类情况建议退回重报，不宜在现有数据上做微调。`;
  }

  let concl, conclColor, conclBg;
  if (danger >= 1) {
    concl = `检出 ${danger} 项红灯${warn ? '、' + warn + ' 项黄灯' : ''} —— 不得仅凭自述数据授信。须补充客观证据或否决；客户对偏差的解释必须"可验证"，不接受口头说明。所有偏差须在贷前报告中留痕，作为尽职免责依据。` + conflictNote;
    conclColor = '#991b1b'; conclBg = '#fef2f2';
  } else if (warn >= 2) {
    concl = `检出 ${warn} 项黄灯 —— 建议压缩授信额度至推算值的 70% 以下，并对每个偏差项取得书面说明与佐证。`;
    conclColor = '#92400e'; conclBg = '#fffbeb';
  } else if (ok >= 2) {
    concl = `${ok} 项校验通过 —— 自述数据与客观证据基本自洽。仍建议按 E 组清单完成现场必取证据后再出结论。`;
    conclColor = '#166534'; conclBg = '#f0fdf4';
  } else {
    concl = '已启用的校验项不足，建议至少填写面积、员工数、月营收，并补充耗电与物料数据以提高置信度。';
    conclColor = '#475569'; conclBg = '#f8fafc';
  }

  return { rows: R, concl: concl, conclColor: conclColor, conclBg: conclBg, stat: { danger, warn, ok } };
}

/* ==========================================================================
 * 页面渲染
 * ========================================================================== */
var DOSSIER_TAB = 'A';

function pageDeepDossier() {
  const DD = (typeof DB !== 'undefined' && DB.deepDossier) ? DB.deepDossier : null;
  const codes = DD ? Object.keys(DD).filter(k => k !== 'meta') : [];

  let html = `<div class="page-head">
    <div>
      <div class="page-title">行业深度档案</div>
      <div class="page-sub">逐行业精写的 L3~L4 级作业档案：单产模型 · 核验钩子 · 交叉验证引擎 · 岗位追问树 · 城市差异</div>
    </div>
  </div>`;

  if (!DD || !codes.length) {
    html += `<div class="section-card"><div class="empty">暂无深度档案数据（DB.deepDossier 为空）。请确认 deep_dossier.js 已加密并部署。</div></div>`;
    return html;
  }

  // 行业选择
  html += `<div class="section-card">
    <div class="section-title">📂 选择行业档案</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      ${codes.map(c => {
        const d = DD[c];
        const meta = d.meta || {};
        return `<button class="btn ${S.dossierCode === c ? 'btn-primary' : ''}" onclick="dpPick('${c}')">${esc(meta.细分行业 || c)} ${dpDepthBadge(meta.整体深度)}</button>`;
      }).join('')}
    </div>
    <div style="margin-top:10px;color:#64748b;font-size:12px;">
      当前共 ${codes.length} 个行业完成深度档案。其余 ${(DB.industries ? DB.industries.length - codes.length : 0)} 个行业仍为基础层（L1~L2），不在此处展示 —— 宁可留白，不用模板拼接。
    </div>
  </div>`;

  const code = S.dossierCode && DD[S.dossierCode] ? S.dossierCode : codes[0];
  const d = DD[code];
  S.dossierCode = code;
  const m = d.meta || {};

  // ---- 档案概览 ----
  html += `<div class="section-card">
    <div class="section-title">📋 档案概览 · ${esc(m.细分行业 || code)}（${esc(code)}）</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">
      ${[['所属行业大类', m.行业大类], ['档案版本', m.档案版本], ['整体深度', null], ['覆盖完整度', m.覆盖完整度], ['核验日期', m.verified_at], ['下次复核', m.下次复核], ['状态', m.状态]]
        .map(([k, v]) => `<div style="background:#f8fafc;border-radius:8px;padding:10px 12px;">
          <div style="color:#64748b;font-size:11.5px;">${esc(k)}</div>
          <div style="font-weight:600;font-size:13px;margin-top:3px;">${k === '整体深度' ? dpDepthBadge(m.整体深度) : esc(v || '—')}</div>
        </div>`).join('')}
    </div>
    <div style="margin-top:12px;padding:10px 12px;background:#f8fafc;border-left:3px solid #cbd5e1;border-radius:0 4px 4px 0;color:#64748b;font-size:12px;line-height:1.7;">
      <b>撰写角色：</b>${esc(m.撰写角色 || '—')}<br>
      <b>免责声明：</b>${esc((DD.meta && DD.meta.免责声明) || '')}
    </div>
  </div>`;

  // ---- 数据体检（放前面，醒目） ----
  if (d.I_数据体检) {
    const chk = d.I_数据体检.检出问题 || [];
    html += `<div class="section-card" style="border-left:4px solid #dc2626;">
      <div class="section-title">🩺 与现有基础数据的勾稽体检（自动检出 ${chk.length} 项）</div>
      <div style="margin-bottom:10px;color:#64748b;font-size:12.5px;line-height:1.7;">${esc(d.I_数据体检.说明 || '')}</div>
      ${chk.map(c => {
        const c2 = c.严重度 === '高' ? ['#dc2626', '#fef2f2'] : c.严重度 === '中' ? ['#d97706', '#fffbeb'] : ['#0ea5e9', '#f0f9ff'];
        return `<div style="margin-bottom:12px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <div style="background:${c2[1]};padding:8px 12px;display:flex;gap:8px;align-items:center;">
          <span style="background:${c2[0]};color:#fff;border-radius:4px;padding:1px 8px;font-size:11px;font-weight:700;">${esc(c.严重度)}</span>
          <b style="font-size:13px;">${esc(c.编号)} · ${esc(c.问题)}</b>
        </div>
        <div style="padding:10px 12px;font-size:12.5px;line-height:1.8;">
          <div><b style="color:#475569;">现有值：</b>${esc(c.现有值 || '—')}</div>
          <div style="margin-top:4px;"><b style="color:#475569;">矛盾点：</b>${esc(c.矛盾点 || '—')}</div>
          <div style="margin-top:4px;"><b style="color:#15803d;">修正建议：</b>${esc(c.修正建议 || '—')}</div>
          <div style="margin-top:4px;"><b style="color:#b91c1c;">对评分的影响：</b>${esc(c.影响 || '—')}</div>
        </div></div>`;
      }).join('')}
    </div>`;
  }

  // ---- 交叉验证计算器 ----
  html += dpRenderCalculator(d, code);

  // ---- 详细档案 Tab ----
  const TABS = [
    ['A', 'A · 准入与证照', 'A_准入'],
    ['B', 'B · 单产模型', 'B_单产模型'],
    ['C', 'C · 产业链', 'C_产业链'],
    ['D', 'D · 失败与包装', 'D_失败与包装'],
    ['F', 'F · 额度与用途', 'F_额度与用途'],
    ['G', 'G · 岗位核验', 'G_岗位核验'],
    ['H', 'H · 城市差异', 'H_城市差异'],
  ];
  html += `<div class="section-card">
    <div class="section-title">📖 详细档案</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #e2e8f0;padding-bottom:10px;margin-bottom:14px;">
      ${TABS.map(([id, label]) => `<button class="btn ${DOSSIER_TAB === id ? 'btn-primary' : ''}" onclick="dpTab('${id}')" style="font-size:12px;padding:5px 12px;">${esc(label)}</button>`).join('')}
    </div>
    <div id="dpTabBody">${dpRenderTab(d, DOSSIER_TAB)}</div>
  </div>`;

  setTimeout(function () { dpBindCalc(); }, 0);
  return html;
}

function dpRenderCalculator(d, code) {
  const E = d.E_交叉验证 || {};
  const items = E.通用输入项 || [];
  const st = S.dossierCalc || {};

  let html = `<div class="section-card" style="border-left:4px solid #16a34a;">
    <div class="section-title">🧮 交叉验证引擎 · ${esc((d.meta && d.meta.细分行业) || code)}（${(E.验证钩子 || []).length} 个校验钩子）</div>
    <div style="margin-bottom:12px;padding:10px 12px;background:#f0fdf4;border-radius:6px;color:#166534;font-size:12.5px;line-height:1.7;">
      <b>设计原则：</b>${esc(E.设计原则 || '')}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">
      <div>
        <div style="font-size:12px;color:#475569;font-weight:600;margin-bottom:4px;">店型（决定翻台率与人效基准）</div>
        <select id="dc_type" class="input">
          ${Object.keys(DOSSIER_STORE_TYPE).map(k => `<option value="${esc(k)}" ${st.type === k ? 'selected' : ''}>${esc(k)}（${DOSSIER_STORE_TYPE[k].area}）</option>`).join('')}
        </select>
      </div>
      ${items.map(it => `
      <div>
        <div style="font-size:12px;color:#475569;font-weight:600;margin-bottom:4px;">${esc(it.名称)}${it.必填 ? ' <span style="color:#dc2626;">*</span>' : ' <span style="color:#94a3b8;">(选填)</span>'}${it.单位 ? `<span style="color:#94a3b8;font-weight:400;">（${esc(it.单位)}）</span>` : ''}</div>
        <input id="dc_${it.key}" class="input" type="number" placeholder="${esc(it.说明 || (it.默认 !== undefined ? '默认 ' + it.默认 : ''))}" value="${st[it.key] !== undefined ? esc(String(st[it.key])) : ''}" />
      </div>`).join('')}
    </div>
    <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn btn-primary" onclick="dpRunCalc()">执行交叉验证</button>
      <button class="btn" onclick="dpFillSample()">填入示例（60万 / 300㎡ / 12人 · 刻意含矛盾）</button>
      <button class="btn" onclick="dpClearCalc()">清空</button>
    </div>
    <div style="margin-top:8px;color:#64748b;font-size:11.5px;line-height:1.7;">
      示例刻意保留了"300㎡、26桌、12人却自述月流水 60 万"这组数据 —— 人效基准只支撑 26.4 万，能耗只支撑约 31.6 万，
      物料只支撑约 37.8 万，三个客观证据同时证伪。用它来看引擎如何把"听起来合理"的自述拆穿。
    </div>
    <div id="dcResult" style="margin-top:16px;">${st.resultHtml || ''}</div>
    <div style="margin-top:14px;">
      <div style="font-size:12px;color:#475569;font-weight:600;margin-bottom:6px;">偏离处置原则</div>
      <ul style="margin:0;padding-left:18px;color:#475569;font-size:12.5px;line-height:1.9;">
        ${(E.偏离处置原则 || []).map(x => '<li>' + esc(x) + '</li>').join('')}
      </ul>
    </div>
  </div>`;
  return html;
}

function dpRenderTab(d, tab) {
  const keyMap = { A: 'A_准入', B: 'B_单产模型', C: 'C_产业链', D: 'D_失败与包装', F: 'F_额度与用途', G: 'G_岗位核验', H: 'H_城市差异' };
  const key = keyMap[tab];
  const v = d[key];
  if (!v) return '<div class="empty">该组暂无内容</div>';
  return dpRenderBlock(v, 0);
}

/* ---------------- 交互 ---------------- */
function dpPick(code) {
  S.dossierCode = code;
  S.dossierCalc = null;
  go('deep-dossier');
}
function dpTab(id) {
  DOSSIER_TAB = id;
  const body = document.getElementById('dpTabBody');
  const DD = DB.deepDossier;
  const d = DD[S.dossierCode];
  if (body && d) body.innerHTML = dpRenderTab(d, DOSSIER_TAB);
  // 同步按钮态
  document.querySelectorAll('[onclick^="dpTab"]').forEach(function (b) {
    const on = b.getAttribute('onclick').indexOf("'" + id + "'") >= 0;
    b.classList.toggle('btn-primary', on);
  });
}
function dpBindCalc() {
  const ids = ['dc_type', 'dc_area', 'dc_tables', 'dc_staff', 'dc_revenue', 'dc_power', 'dc_sauce', 'dc_rent', 'dc_guest', 'dc_payment'];
  ids.forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter') dpRunCalc(); });
  });
}
function dpCollect() {
  const g = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const n = id => { const v = parseFloat(g(id)); return isNaN(v) ? 0 : v; };
  const typeEl = document.getElementById('dc_type');
  return {
    storeType: typeEl ? typeEl.value : '标准商业店',
    area: n('dc_area'), tables: n('dc_tables'), staff: n('dc_staff'),
    revenue: n('dc_revenue'), power: n('dc_power'), sauce: n('dc_sauce'),
    rent: n('dc_rent'), guest: n('dc_guest') || 80, payment: n('dc_payment'),
  };
}
function dpRunCalc() {
  const inp = dpCollect();
  if (!inp.revenue && !inp.area && !inp.staff) {
    const r = document.getElementById('dcResult');
    if (r) r.innerHTML = '<div class="empty">请至少填写 面积 / 员工数 / 月营收 中的一项</div>';
    return;
  }
  const res = deepCrossCheck(inp);
  let h = `<div style="padding:12px 14px;border-radius:8px;background:${res.conclBg};color:${res.conclColor};font-size:13px;line-height:1.8;margin-bottom:12px;">
    <b>综合结论：</b>${esc(res.concl)}</div>`;
  h += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12.5px;">';
  h += '<tr><th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">钩子</th><th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">维度</th><th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">名称</th><th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">推算值</th><th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">自述/实际</th><th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">偏差</th><th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">判定</th><th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">处置建议 / 依据</th></tr>';
  res.rows.forEach(function (r) {
    const dv = r.dev === null || r.dev === undefined ? '—' : (r.dev > 0 ? '+' : '') + dpPct(r.dev);
    h += `<tr>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-weight:600;">${esc(r.id)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;">${esc(r.dim)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;">${esc(r.name)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;">${esc(r.calc)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;">${esc(r.actual)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-weight:600;">${esc(dv)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;">${dpLevelBadge(r.level)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;line-height:1.7;max-width:340px;">
        ${esc(r.advice)}<div style="color:#94a3b8;font-size:11px;margin-top:3px;">${esc(r.basis || '')}</div>
      </td></tr>`;
  });
  h += '</table></div>';
  const r = document.getElementById('dcResult');
  if (r) r.innerHTML = h;
  S.dossierCalc = Object.assign({ resultHtml: h }, inp);
}
function dpFillSample() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  const t = document.getElementById('dc_type'); if (t) t.value = '标准商业店';
  set('dc_area', 300); set('dc_tables', 26); set('dc_staff', 12);
  set('dc_revenue', 600000); set('dc_power', 7800); set('dc_sauce', 4200);
  set('dc_rent', 45000); set('dc_guest', 90); set('dc_payment', 18000);
  dpRunCalc();
}
function dpClearCalc() {
  ['dc_area', 'dc_tables', 'dc_staff', 'dc_revenue', 'dc_power', 'dc_sauce', 'dc_rent', 'dc_guest', 'dc_payment'].forEach(function (id) {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  S.dossierCalc = null;
  const r = document.getElementById('dcResult'); if (r) r.innerHTML = '';
}

/* ---------------- 注册到主程序 ---------------- */
(function () {
  try {
    PAGES['deep-dossier'] = pageDeepDossier;
    PAGE_TITLE['deep-dossier'] = '行业深度档案';
    // 插入导航：放在"工具"组最前
    var tools = null;
    for (var i = 0; i < NAV.length; i++) { if (NAV[i].g === '工具') { tools = NAV[i]; break; } }
    if (tools) {
      if (!tools.items.some(function (x) { return x.id === 'deep-dossier'; })) {
        tools.items.unshift({ id: 'deep-dossier', ico: '🔬', t: '行业深度档案' });
      }
    } else {
      NAV.push({ g: '深度档案', items: [{ id: 'deep-dossier', ico: '🔬', t: '行业深度档案' }] });
    }
  } catch (e) {
    console.warn('深度档案页注册失败', e);
  }
})();
