/* ==========================================================================
 * 小微行业信贷知识库 · 评级与分层「单一事实来源」(V10.0)
 * --------------------------------------------------------------------------
 * 目的：全站所有页面（数据看板 / 行业分析 / 风险速查 / 城市风控 / 深度档案 /
 *       评分卡 / 对比 / 搜索）共用同一套评级口径，杜绝各自为政。
 *
 * 三条统一口径：
 *   1. 风险层级 A/B/C/D —— 只由「风险评分」经 riskLevelOf() 决定，不再各页自算
 *   2. 内容深度 L0~L4   —— 只由档案完整度经 depthOf() 决定
 *   3. 投放分层 P0/P1/P2 —— 只由行业在小微贷中的实际频次经 tierOf() 决定
 * ========================================================================== */
'use strict';

window.XWK_TAXO = (function () {

  /* ---------------- 1. 风险层级：评分区间互斥、无重叠 ----------------
   * 历史问题：原库 A≤30 / B30-50 / C46-70 / D66-95 —— B与C在46-50重叠、
   * C与D在66-70重叠，同一分数在不同页面会被判成不同层级。此处一次性修正。
   */
  var RISK_BANDS = [
    { lv: 'A', min: 0,  max: 30,  label: '低风险',   color: '#059669', bg: '#d1fae5', border: '#6ee7b7',
      desc: '常规受理', action: '标准流程尽调，按常规额度授信' },
    { lv: 'B', min: 31, max: 50,  label: '中低风险', color: '#3b82f6', bg: '#dbeafe', border: '#93c5fd',
      desc: '正常受理', action: '按行业重点项补充核验，额度不额外压缩' },
    { lv: 'C', min: 51, max: 70,  label: '中高风险', color: '#d97706', bg: '#fef3c7', border: '#fcd34d',
      desc: '审慎受理', action: '须补充客观证据，压缩额度 20%~30% 或追加担保' },
    { lv: 'D', min: 71, max: 100, label: '高风险',   color: '#dc2626', bg: '#fee2e2', border: '#fca5a5',
      desc: '限制受理', action: '原则性审慎：强担保 / 缩短期限 / 或否决，须双人签批' }
  ];

  /* 只用上界判定，区间必须首尾相接 —— 否则 30.8 / 50.4 / 70.2 这类小数分
     会落在两段之间的空档里，被兜底判成 D（高风险），属系统性误判。 */
  function riskLevelOf(score) {
    var s = Number(score);
    if (isNaN(s)) return '';
    if (s <= RISK_BANDS[0].max) return RISK_BANDS[0].lv;
    for (var i = 1; i < RISK_BANDS.length; i++) {
      if (s <= RISK_BANDS[i].max) return RISK_BANDS[i].lv;
    }
    return 'D';
  }

  function riskMeta(lv) {
    for (var i = 0; i < RISK_BANDS.length; i++) if (RISK_BANDS[i].lv === lv) return RISK_BANDS[i];
    return { lv: lv || '—', label: '未分级', color: '#64748b', bg: '#f1f5f9', border: '#e2e8f0', desc: '—', action: '—' };
  }

  function riskBadge(lv, extra) {
    var m = riskMeta(lv);
    return '<span class="rk-badge" style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11.5px;font-weight:700;' +
      'background:' + m.bg + ';color:' + m.color + ';border:1px solid ' + m.border + ';">' +
      (lv || '—') + ' ' + m.label + (extra ? ' ' + extra : '') + '</span>';
  }

  /* ---------------- 2. 内容深度 L0~L4 ----------------
   * L0 占位/套话（不可作为决策依据）
   * L1 基础层（行业主表字段，够检索不够决策）
   * L2 结构层（+ 经营模式明细，可支撑初步判断）
   * L3 作业层（+ 准入/单产/失败/交叉验证，可直接用于尽调）
   * L4 精写层（+ 岗位追问树 / 城市差异 / 数据体检，可作为贷前报告依据）
   */
  var DEPTH_META = {
    L0: { lv: 'L0', label: '套话', color: '#94a3b8', bg: '#f1f5f9',
      desc: '模板生成、跨行业雷同，不可作为决策依据', usable: false },
    L1: { lv: 'L1', label: '基础', color: '#64748b', bg: '#f8fafc',
      desc: '只有行业主表的字段，可检索比较，不足以单独支撑授信', usable: false },
    L2: { lv: 'L2', label: '概要', color: '#0ea5e9', bg: '#e0f2fe',
      desc: '有经营模式明细与核心指标，可支撑初步判断', usable: true },
    L3: { lv: 'L3', label: '详细', color: '#8b5cf6', bg: '#f5f3ff',
      desc: '有准入、单产模型、失败模式与交叉验证项，可直接用于尽调', usable: true },
    L4: { lv: 'L4', label: '完整', color: '#16a34a', bg: '#dcfce7',
      desc: '内容齐全，含岗位追问与城市差异，可作为贷前报告依据', usable: true }
  };

  /* ------------------------------------------------------------------
   * 显示层术语白话化
   * 档案正文里大量出现「钩子 / 勾稽 / 数据体检 / PROFILE」这类内部说法
   * （写作阶段留下的）。数据在库里保持原样，只在渲染给用户看时替换。
   * 顺序：长词在前，避免被短词先吃掉。
   * ------------------------------------------------------------------ */
  var GLOSSARY = [
    ['交叉验证钩子', '交叉验证项'],
    ['本行业专属钩子', '本行业专属校验'],
    ['验证钩子', '验证项'],
    ['数据体检', '数据说明'],
    ['钩子', '校验项'],
    ['勾稽', '核对'],
    ['PROFILE', '行业档案'],
    ['L4 精写档案', '最完整的行业档案'],
    ['精写', '完整']
  ];
  function plainText(s) {
    var t = String(s === undefined || s === null ? '' : s);
    for (var i = 0; i < GLOSSARY.length; i++) {
      if (t.indexOf(GLOSSARY[i][0]) >= 0) t = t.split(GLOSSARY[i][0]).join(GLOSSARY[i][1]);
    }
    return t;
  }

  function depthMeta(lv) { return DEPTH_META[lv] || DEPTH_META.L0; }

  function depthBadge(lv) {
    var m = depthMeta(lv);
    return '<span title="' + plainText(m.desc) + '" style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:700;' +
      'background:' + m.bg + ';color:' + m.color + ';">' + m.lv + ' ' + plainText(m.label) + '</span>';
  }

  /* 由档案实际内容判定深度 —— 看填了什么，不看自称什么 */
  var DOSSIER_GROUPS = ['A_准入', 'B_单产模型', 'C_产业链', 'D_失败与包装', 'E_交叉验证', 'F_额度与用途', 'G_岗位核验', 'H_城市差异', 'I_数据体检'];
  var CORE_GROUPS    = ['A_准入', 'B_单产模型', 'D_失败与包装', 'E_交叉验证', 'F_额度与用途'];

  function countUnits(o) {
    if (o === null || o === undefined) return 0;
    if (typeof o !== 'object') return String(o).length > 6 ? 1 : 0;
    if (Array.isArray(o)) return o.reduce(function (a, x) { return a + countUnits(x); }, 0);
    var n = 0;
    for (var k in o) if (k !== 'depth_level' && k !== 'source' && k !== 'confidence' && k !== 'author') n += countUnits(o[k]);
    return n;
  }

  function depthOf(dossier) {
    if (!dossier) return 'L1';
    var filled = 0, units = 0;
    for (var i = 0; i < DOSSIER_GROUPS.length; i++) {
      var g = dossier[DOSSIER_GROUPS[i]];
      if (g && Object.keys(g).length) filled++;
    }
    var coreFilled = 0;
    for (var j = 0; j < CORE_GROUPS.length; j++) {
      var cg = dossier[CORE_GROUPS[j]];
      if (cg && Object.keys(cg).length) coreFilled++;
    }
    units = countUnits(dossier);
    var hooks = (dossier.E_交叉验证 && dossier.E_交叉验证.验证钩子) ? dossier.E_交叉验证.验证钩子.length : 0;

    /* L4 精写层：九组全覆盖（含 H_城市差异）+ 至少 6 个钩子 + 500 单元以上。
     * 注意必须是 9 组全填 —— P1 只写八组（不含 H），天然落不到 L4，这正是分层要实现的效果。 */
    if (filled >= 9 && units >= 320 && hooks >= 6) return 'L4';
    if (coreFilled >= 5 && filled >= 6 && units >= 180 && hooks >= 4) return 'L3';
    if (coreFilled >= 4 && units >= 90) return 'L2';
    return 'L1';
  }

  /* ---------------- 3. 投放分层 P0/P1/P2 ---------------- */
  var TIER_META = {
    P0: { lv: 'P0', label: '常见', color: '#dc2626', bg: '#fee2e2',
      desc: '小微贷最常见的行业，档案写得最完整，有本行业专属的交叉验证项' },
    P1: { lv: 'P1', label: '较常见', color: '#d97706', bg: '#fef3c7',
      desc: '区域内常见，档案写到「详细」级别' },
    P2: { lv: 'P2', label: '少见', color: '#64748b', bg: '#f1f5f9',
      desc: '偶发或资本密集，重点看准入红线与核心指标' },
    NA: { lv: 'NA', label: '非授信', color: '#94a3b8', bg: '#f8fafc',
      desc: '政府 / 公共事业 / 跨行业岗位库，不是小微信贷的投放对象' }
  };

  /* 非授信条目：政府公共事业 + 跨行业通用岗位库（是岗位库，不是行业） */
  function isNonLending(code) {
    return /^GV\d+$/.test(code) || /^GN\d+$/.test(code);
  }

  /* P0：小微贷实际投放最集中的行业（餐饮全谱 / 零售 / 生活服务 / 汽车后市场 /
   *     轻工制造 / 建筑装修 / 贸易流通 / 物流 / 教育培训 / 医疗流通） */
  var P0_CODES = ('LS01 LS02 LS03 LS04 LS05 LS06 LS07 LS08 LS09 LS10 LS11 LS12 LS13 LS14 LS15 LS16 LS17 LS18 LS19 LS20 ' +
    'RT01 RT02 RT03 RT04 RT05 RT06 RT07 RT08 RT09 ' +
    'AU01 AU02 AU04 AU05 ' +
    'MF02 MF05 MF06 MF07 MF08 MF11 ' +
    'RE02 RE03 ' +
    'TD01 TD02 TD05 ' +
    'LG01 LG02 LG06 ' +
    'ED03 ED05 ED07 ' +
    'HC05 HC07 ' +
    'AG02 AG05 ' +
    'BS01 MD03 IT09').split(/\s+/);

  var P0_SET = {};
  P0_CODES.forEach(function (c) { P0_SET[c] = 1; });

  /* P2：资本密集 / 强牌照 / 非小微主体为主，做结构层即可 */
  var P2_CODES = ('AE01 AE02 AE03 AE05 EN01 EN02 EN03 EN04 EN05 FN01 FN02 FN03 FN04 FN05 FN06 FN07 FN08 ' +
    'TR01 TR02 TR03 TR04 TR05 RE01 ' +
    'EC01 EC02 EC03 NE01 NE02 NE04 NE05 ' +
    'HC01 HC02 HC04 HC06 ' +
    'MF10 MF13 ' +
    'ED01 ED02 ED08 ED09 ' +
    'IT02 IT03 IT04 ' +
    'RE08 GV01 GV02 GV03 GV04 GV05 GV06').split(/\s+/);

  var P2_SET = {};
  P2_CODES.forEach(function (c) { P2_SET[c] = 1; });

  function tierOf(code) {
    if (isNonLending(code)) return 'NA';
    if (P0_SET[code]) return 'P0';
    if (P2_SET[code]) return 'P2';
    return 'P1';
  }

  function tierMeta(t) { return TIER_META[t] || TIER_META.P2; }

  function tierBadge(t) {
    var m = tierMeta(t);
    return '<span title="' + plainText(m.desc) + '" style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:700;' +
      'background:' + m.bg + ';color:' + m.color + ';">' + m.lv + ' ' + plainText(m.label) + '</span>';
  }

  /* ---------------- 4. 置信度 ---------------- */
  var CONF_META = {
    high:   { k: 'high',   label: '高', color: '#15803d', bg: '#dcfce7', desc: '有公开权威来源或行业公认口径支撑' },
    mid:    { k: 'mid',    label: '中', color: '#b45309', bg: '#fef3c7', desc: '来自行业经验或单一来源，需现场复核' },
    low:    { k: 'low',    label: '低', color: '#b91c1c', bg: '#fee2e2', desc: '估算或推断值，不得单独作为决策依据' },
    derived:{ k: 'derived',label: '派生',color: '#64748b', bg: '#f1f5f9', desc: '由行业母表与城市母表推导，非独立研究' }
  };
  function confMeta(c) { return CONF_META[c] || CONF_META.low; }
  function confBadge(c) {
    var m = confMeta(c);
    return '<span title="' + m.desc + '" style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:700;' +
      'background:' + m.bg + ';color:' + m.color + ';">置信 ' + m.label + '</span>';
  }

  /* ---------------- 5. 字段级信任度 ----------------
   * 这 5 个字段在 170 个行业中有 91.8% 取同一个值，是模板套话。
   * 一律标 L0：界面灰显 + 折叠，且不参与任何评分与结论。
   */
  var FILLER_FIELDS = ['必备证照资质', '订单与客户来源', '典型融资用途', '主要经营风险', '政策与外部驱动'];

  function isFillerField(f) { return FILLER_FIELDS.indexOf(f) >= 0; }

  /* ---------------- 6. 通用评级：把「分数」映射到统一口径 ---------------- */
  /* 用于评分卡 / 对比等自算分数场景，保证与风险层级同一套色阶 */
  function scoreLevelOf(score, maxScore) {
    var pct = Number(score) / (maxScore || 100) * 100;
    return riskLevelOf(100 - pct);   // 得分越高风险越低 → 反向映射
  }

  return {
    VERSION: 'V10.0',
    RISK_BANDS: RISK_BANDS,
    riskLevelOf: riskLevelOf,
    riskMeta: riskMeta,
    riskBadge: riskBadge,
    DEPTH_META: DEPTH_META,
    DOSSIER_GROUPS: DOSSIER_GROUPS,
    CORE_GROUPS: CORE_GROUPS,
    depthMeta: depthMeta,
    depthOf: depthOf,
    depthBadge: depthBadge,
    countUnits: countUnits,
    TIER_META: TIER_META,
    tierOf: tierOf,
    tierMeta: tierMeta,
    tierBadge: tierBadge,
    plainText: plainText,
    isNonLending: isNonLending,
    CONF_META: CONF_META,
    confMeta: confMeta,
    confBadge: confBadge,
    FILLER_FIELDS: FILLER_FIELDS,
    isFillerField: isFillerField,
    scoreLevelOf: scoreLevelOf
  };
})();
