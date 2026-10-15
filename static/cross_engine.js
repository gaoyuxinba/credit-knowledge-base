/* ==========================================================================
 * 小微行业信贷知识库 · 通用交叉验证引擎 (V10.0)
 * --------------------------------------------------------------------------
 * 与 V9.5 的区别：
 *   V9.5 只有火锅一套硬编码八钩子；本引擎由**行业档案自带的钩子配置**驱动，
 *   每个行业有自己的钩子、系数与阈值，不复用通用模板。
 *
 * 钩子三种判定模式：
 *   dev      偏差型：推算值 vs 自述值，按相对偏差分级（默认）
 *   ratio    比率型：直接算出一个比率，与阈值比较（房租占比、DSCR 等）
 *   floor    底线型：算出一条底线，看实际值是否站得住（保本线、最低人效等）
 *
 * 表达式求值：只接受档案自带的 expr（我方数据），不接收任何用户输入字符串。
 * ========================================================================== */
'use strict';

window.XWK_ENGINE = (function () {

  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function fmt(v, unit) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var u = unit || '';
    if (/元|万|营收|额/.test(u) && Math.abs(v) >= 10000) return (v / 10000).toFixed(1) + ' 万' + (/元/.test(u) ? '元' : '');
    return Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + (u ? ' ' + u : '');
  }
  function pct(v, d) { return (v === null || v === undefined || isNaN(v)) ? '—' : (v * 100).toFixed(d === undefined ? 1 : d) + '%'; }

  /* 只允许这些内联助手（不含 Math 等全局对象），避免表达式逃出沙箱 */
  var HELPERS = {
    max: function () { return Math.max.apply(null, arguments); },
    min: function () { return Math.min.apply(null, arguments); },
    abs: Math.abs,
    round: Math.round
  };

  function evalExpr(expr, scope) {
    if (!expr) return null;
    var s = Object.assign({}, HELPERS, scope);
    var keys = Object.keys(s);
    try {
      /* eslint-disable no-new-func */
      var fn = new Function(keys.join(','), 'return (' + expr + ');');
      /* 注意：形参名来自合并后的 s（含 HELPERS），取值也必须来自 s，否则会整体错位 */
      var args = keys.map(function (k) { return s[k]; });
      var v = fn.apply(null, args);
      return (typeof v === 'number' && isFinite(v)) ? v : null;
    } catch (e) { return null; }
  }

  /* 收集输入项（含档位 select 注入的变量） */
  function inputsOf(profile) {
    var E = (profile.dossier && profile.dossier.E_交叉验证) || {};
    return E.通用输入项 || [];
  }

  function buildScope(inputs, defs, values) {
    var scope = {};
    (defs || []).forEach(function (it) {
      if (it.type === 'select') {
        var sel = values[it.key];
        var opt = (it.选项 || []).filter(function (o) { return o.值 === sel; })[0] || it.选项[0];
        if (opt && opt.vars) for (var k in opt.vars) scope[k] = opt.vars[k];
        scope[it.key] = sel || (it.选项 && it.选项[0] && it.选项[0].值);
        return;
      }
      var v = parseFloat(values[it.key]);
      scope[it.key] = isNaN(v) ? (it.默认 !== undefined ? it.默认 : 0) : v;
    });
    return scope;
  }

  var LEVEL_META = {
    ok:     { t: '✔ 正常',   color: '#15803d', bg: '#dcfce7' },
    warn:   { t: '⚠ 关注',   color: '#b45309', bg: '#fef3c7' },
    danger: { t: '✖ 红灯',   color: '#b91c1c', bg: '#fee2e2' },
    na:     { t: '— 未启用', color: '#64748b', bg: '#f1f5f9' }
  };
  function badge(lv) {
    var m = LEVEL_META[lv] || LEVEL_META.na;
    return '<span style="display:inline-block;padding:2px 10px;border-radius:10px;background:' + m.bg + ';color:' + m.color + ';font-size:12px;font-weight:600;">' + m.t + '</span>';
  }

  /* ---------------- 主计算 ---------------- */
  function run(profile, values) {
    var E = (profile.dossier && profile.dossier.E_交叉验证) || {};
    var defs = E.通用输入项 || [];
    var hooks = E.验证钩子 || [];
    var scope = buildScope(inputsOf(profile), defs, values || {});
    var rows = [];

    hooks.forEach(function (h) {
      var mode = h.mode || 'dev';
      var calc = evalExpr(h.expr, scope);
      var calcLow = h.expr_low ? evalExpr(h.expr_low, scope) : null;
      var calcHigh = h.expr_high ? evalExpr(h.expr_high, scope) : null;
      var actual = null;
      var actualKey = h.actual || 'revenue';
      if (values && values[actualKey] !== undefined && values[actualKey] !== '') actual = parseFloat(values[actualKey]);

      var unit = h.单位 || '';
      var calcTxt = (calcLow !== null && calcHigh !== null)
        ? fmt(calcLow, unit) + ' ~ ' + fmt(calcHigh, unit) + '（中位 ' + fmt(calc, unit) + '）'
        : fmt(calc, unit);

      var row = {
        id: h.id || '—', dim: h.dim || '—', name: h.名称 || '—',
        calc: calcTxt, actual: (actual === null || isNaN(actual)) ? '未填' : fmt(actual, unit),
        dev: null, level: 'na', advice: '', basis: h.依据 || ''
      };

      if (calc === null) {
        row.advice = '所需输入项缺失，本项未启用（' + (h.启用条件 || '请填写相关输入项') + '）';
        rows.push(row); return;
      }

      var th = h.阈值 || { ok: 0.20, warn: 0.40 };
      var adv = h.处置建议 || {};

      if (mode === 'ratio') {
        /* 比率型：expr 算出比率（如 房租/营收、净利/月供） */
        var v = calc;
        var higherBetter = h.方向 === '越高越好';
        var okT = th.ok, warnT = th.warn;
        /* 比率型是"绝对水平 vs 阈值"，不是"自述 vs 推算"，
         * 因此不产出 dev —— 否则会把健康的低房租占比误算成"自述偏低"，污染方向冲突判定 */
        if (higherBetter) {
          row.level = v < warnT ? 'danger' : v < okT ? 'warn' : 'ok';
        } else {
          row.level = v > warnT ? 'danger' : v > okT ? 'warn' : 'ok';
        }
        row.dev = null;
        row.calc = '阈值：正常 ≤' + pct(okT, 0) + '，危险 >' + pct(warnT, 0) + (higherBetter ? '（越高越好）' : '');
        row.actual = pct(v) + (h.实际说明 ? '（' + h.实际说明 + '）' : '');
        row.advice = row.level === 'danger' ? (adv.高 || '') : row.level === 'warn' ? (adv.中 || adv.高 || '') : (adv.正常 || '');
      } else if (mode === 'floor') {
        /* 底线型：expr 算出底线（如保本营收），看实际站不站得住 */
        if (actual === null || isNaN(actual)) {
          row.advice = '未填自述值，无法比对底线';
        } else {
          var margin = th.ok || 1.2;
          row.level = actual < calc ? 'danger' : actual < calc * margin ? 'warn' : 'ok';
          row.dev = (actual - calc) / calc;
          row.advice = row.level === 'danger' ? (adv.低 || '') : row.level === 'warn' ? (adv.中 || '') : (adv.正常 || '');
        }
        row.calc = '底线 ' + fmt(calc, unit) + (h.底线说明 ? '（' + h.底线说明 + '）' : '');
      } else {
        /* 偏差型：推算 vs 自述 */
        if (actual === null || isNaN(actual) || !calc) {
          row.advice = '未填自述值或与推算值同为 0，本项未启用';
        } else {
          var d = (actual - calc) / calc;
          var a = Math.abs(d);
          row.dev = d;
          row.level = a <= th.ok ? 'ok' : a <= th.warn ? 'warn' : 'danger';
          row.advice = d > 0 ? (row.level === 'ok' ? (adv.正常 || '') : (adv.高 || ''))
                             : (row.level === 'ok' ? (adv.正常 || '') : (adv.低 || ''));
        }
      }

      if (!row.advice) row.advice = adv.正常 || '在合理区间';
      rows.push(row);
    });

    /* 综合结论（含方向冲突检测） */
    var enabled = rows.filter(function (r) { return r.level !== 'na'; });
    var danger = enabled.filter(function (r) { return r.level === 'danger'; }).length;
    var warn = enabled.filter(function (r) { return r.level === 'warn'; }).length;
    var ok = enabled.filter(function (r) { return r.level === 'ok'; }).length;

    var devs = enabled.filter(function (r) { return r.dev !== null && !isNaN(r.dev); });
    var up = devs.filter(function (r) { return r.dev > 0.20; }).length;
    var down = devs.filter(function (r) { return r.dev < -0.20; }).length;
    var conflict = up > 0 && down > 0;
    var conflictNote = conflict
      ? ' ⚠ 特别注意：' + up + ' 项证据显示自述偏高、' + down + ' 项显示偏低 —— 各项客观证据互相矛盾，说明这套自述数据整体不自洽，不是某一项算错，而是数据本身对不上。此类情况建议退回重报，不宜在现有数据上做微调。'
      : '';

    var concl, conclColor, conclBg;
    if (danger >= 1) {
      concl = '检出 ' + danger + ' 项红灯' + (warn ? '、' + warn + ' 项黄灯' : '') + ' —— 不得仅凭自述数据授信。须补充客观证据或否决；客户对偏差的解释必须可验证，不接受口头说明。所有偏差须在贷前报告中留痕，作为尽职免责依据。' + conflictNote;
      conclColor = '#991b1b'; conclBg = '#fef2f2';
    } else if (warn >= 2) {
      concl = '检出 ' + warn + ' 项黄灯 —— 建议压缩授信额度至推算值的 70% 以下，并对每个偏差项取得书面说明与佐证。';
      conclColor = '#92400e'; conclBg = '#fffbeb';
    } else if (ok >= 2) {
      concl = ok + ' 项校验通过 —— 自述数据与客观证据基本自洽。仍建议按 D 组「一击即破核验动作清单」完成现场取证据后再出结论。';
      conclColor = '#166534'; conclBg = '#f0fdf4';
    } else {
      concl = '已启用的校验项不足。请至少填写必填项（通常含经营规模、用工人数、月营收），补充能耗/物料/采购等客观数据可显著提高置信度。';
      conclColor = '#475569'; conclBg = '#f8fafc';
    }

    return { rows: rows, concl: concl, conclColor: conclColor, conclBg: conclBg, stat: { danger: danger, warn: warn, ok: ok, na: rows.length - enabled.length }, conflict: conflict };
  }

  /* 渲染：输入表单 + 结果表 */
  /* 显示层：先做术语白话化，再转义 */
  function pes(s) {
    if (s === undefined || s === null) return '';
    return esc(XWK_TAXO.plainText(String(s)));
  }
  function renderHtml(profile, state) {
    var E = (profile.dossier && profile.dossier.E_交叉验证) || {};
    var defs = E.通用输入项 || [];
    var hooks = E.验证钩子 || [];
    var st = state || {};
    var T = window.XWK_TAXO;
    var dm = T.depthMeta(profile.depth);

    var h = '<div class="section-card" style="border-left:4px solid ' + (profile.hooks.length ? '#16a34a' : '#cbd5e1') + ';">';
    h += '<div class="section-title">🧮 交叉验证 · ' + pes(profile.name) + '</div>';

    if (!hooks.length) {
      h += '<div class="empty-sm">该行业尚未配置交叉验证项（当前数据细致度 ' + profile.depth + ' ' + dm.label + '）。' +
        '只有做到 L3 及以上的行业才有 —— 如需对该行业做交叉验证，请先补齐这部分档案内容。</div></div>';
      return h;
    }

    h += '<div style="margin-bottom:12px;padding:10px 12px;background:#f0fdf4;border-radius:6px;color:#166534;font-size:12.5px;line-height:1.7;">' +
      '<b>设计原则：</b>' + pes(E.设计原则 || '') + '</div>';

    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;">';
    defs.forEach(function (it) {
      if (it.type === 'select') {
        h += '<div><div style="font-size:12px;color:#334155;font-weight:600;margin-bottom:4px;">' + pes(it.名称) + '</div>' +
          '<select id="xe_' + pes(it.key) + '" class="input">' +
          (it.选项 || []).map(function (o) {
            return '<option value="' + pes(o.值) + '"' + (st[it.key] === o.值 ? ' selected' : '') + '>' + pes(o.值) + (o.说明 ? '（' + pes(o.说明) + '）' : '') + '</option>';
          }).join('') + '</select></div>';
        return;
      }
      var unit = it.单位 ? '<span style="color:#94a3b8;font-weight:400;">（' + pes(it.单位) + '）</span>' : '';
      h += '<div><div style="font-size:12px;color:#334155;font-weight:600;margin-bottom:4px;">' + pes(it.名称) +
        (it.必填 ? ' <span style="color:#dc2626;">*</span>' : ' <span style="color:#94a3b8;">(选填)</span>') + unit + '</div>' +
        '<input id="xe_' + pes(it.key) + '" class="input" type="number" placeholder="' + pes(it.说明 || '') + '" value="' + (st[it.key] !== undefined ? pes(String(st[it.key])) : '') + '" /></div>';
    });
    h += '</div>';

    h += '<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;">' +
      '<button class="btn btn-primary" onclick="xeRun()">执行交叉验证</button>' +
      '<button class="btn" onclick="xeClear()">清空</button></div>';
    h += '<div id="xeResult" style="margin-top:16px;">' + (st.resultHtml || '') + '</div>';

    h += '<div style="margin-top:14px;"><div style="font-size:12px;color:#334155;font-weight:600;margin-bottom:6px;">偏离处置原则</div>' +
      '<ul style="margin:0;padding-left:18px;color:#334155;font-size:12.5px;line-height:1.9;">' +
      (E.偏离处置原则 || []).map(function (x) { return '<li>' + pes(x) + '</li>'; }).join('') + '</ul></div></div>';
    return h;
  }

  function collectValues(profile) {
    var defs = inputsOf(profile);
    var v = {};
    defs.forEach(function (it) {
      var el = document.getElementById('xe_' + it.key);
      if (!el) return;
      if (it.type === 'select') v[it.key] = el.value;
      else { var n = parseFloat(el.value); v[it.key] = isNaN(n) ? (it.默认 !== undefined ? it.默认 : '') : n; }
    });
    return v;
  }

  function resultHtml(res) {
    var h = '<div style="padding:12px 14px;border-radius:8px;background:' + res.conclBg + ';color:' + res.conclColor + ';font-size:13px;line-height:1.8;margin-bottom:12px;"><b>综合结论：</b>' + pes(res.concl) + '</div>';
    h += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12.5px;">';
    h += '<tr><th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">校验项</th>' +
      '<th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">维度</th>' +
      '<th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">名称</th>' +
      '<th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">推算值 / 阈值</th>' +
      '<th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">自述实际</th>' +
      '<th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">偏差</th>' +
      '<th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">判定</th>' +
      '<th style="text-align:left;padding:8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">处置建议 / 依据</th></tr>';
    res.rows.forEach(function (r) {
      var dv = (r.dev === null || isNaN(r.dev)) ? '—' : (r.dev > 0 ? '+' : '') + pct(r.dev);
      h += '<tr><td style="padding:8px;border-bottom:1px solid #f1f5f9;font-weight:600;">' + pes(r.id) + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;">' + pes(r.dim) + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;">' + pes(r.name) + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;">' + pes(r.calc) + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;">' + pes(r.actual) + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;font-weight:600;">' + pes(dv) + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;">' + badge(r.level) + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;line-height:1.7;max-width:340px;">' + pes(r.advice) +
        (r.basis ? '<div style="color:#94a3b8;font-size:11px;margin-top:3px;">' + pes(r.basis) + '</div>' : '') + '</td></tr>';
    });
    return h + '</table></div>';
  }

  /* ==================================================================
   * F2 · 六维证据矩阵
   *
   * 每个行业的钩子是逐行业写死的（1107 个），维度标签有 60+ 种自由写法，
   * 无法直接看出「收入/产能/存货/采购/员工/利润」六维各自覆盖到什么程度。
   * 这里做两件事：
   *   1) 把自由 dim 归一到六维，算出该行业每维已有几个钩子、公式与阈值是什么；
   *   2) 缺维时给出**由本行业档案数值派生的通用校验式**（不是通用模板常数），
   *      档案里没有对应基准的一律写「须现场实测」，不编造。
   * ================================================================== */
  var SIX_DIM = [
    { k: '收入', d: '自述营收能不能被客观证据对上' },
    { k: '产能', d: '场地/设备/人手的产能能不能支撑自述规模' },
    { k: '存货', d: '存货水平与周转是否落在本行业基准内' },
    { k: '采购', d: '采购额与成本口径是否自洽、能不能被上游凭证印证' },
    { k: '员工', d: '用工人数与人效是否匹配' },
    { k: '利润', d: '净利与现金流能否覆盖月供' }
  ];

  /* 自由 dim → 六维（只归六维内，其余归「其它」不计入矩阵） */
  var DIM2SIX = {
    收入: '收入', 营收: '收入', 销量: '收入', 订单: '收入', 业务量: '收入', 客流: '收入',
    获客: '收入', 价格: '收入', 定价: '收入', 渠道: '收入', 会员: '收入', 商户: '收入',
    用户: '收入', 收入结构: '收入', 收入质量: '收入', 支付结构: '收入', 品类: '收入',
    网点: '收入', 业务结构: '收入', 交付: '收入', 持续经营: '收入', 结算: '收入', 收汇: '收入',
    产能: '产能', 人效: '产能', 面积: '产能', 场地: '产能', 能耗: '产能', 运营: '产能',
    投入: '产能', 规模: '产能', 资产: '产能', 物流: '产能', 配送: '产能', 质量: '产能',
    损耗: '产能', 教学: '产能', 学员: '产能', 师资: '产能', 研发: '产能', 团队: '产能',
    存货: '存货', 库存: '存货', 周转: '存货',
    采购: '采购', 应付: '采购', 保税: '采购', 报关: '采购', 汇率: '采购', 税务: '采购',
    员工: '员工', 人力: '员工',
    利润: '利润', 盈利: '利润', 毛利: '利润', 成本: '利润', 退费: '利润', 偿债: '利润',
    现金流: '利润', 现金: '利润', 资金: '利润', 负债: '利润', 杠杆: '利润'
  };

  function midOf(s) {
    var m = String(s || '').replace(/[％\s]/g, '').match(/(-?\d+(?:\.\d+)?)\s*%?\s*[-~至到]\s*(-?\d+(?:\.\d+)?)/);
    if (m) return (parseFloat(m[1]) + parseFloat(m[2])) / 2;
    var one = String(s || '').replace(/[％\s]/g, '').match(/(-?\d+(?:\.\d+)?)\s*%/);
    return one ? parseFloat(one[1]) : null;
  }
  function daysOf(t) {
    var m = String(t || '').match(/(\d+)\s*~/);
    if (m) return parseInt(m[1], 10);
    var m2 = String(t || '').match(/(\d+)\s*天/);
    return m2 ? parseInt(m2[1], 10) : null;
  }
  /* 档案字段可能是 {值,depth_level,source} 包装，统一取文本 */
  function txt(v) {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (Array.isArray(v)) return v.map(txt).filter(Boolean).join('；');
    if (typeof v === 'object') {
      if (v['值'] !== undefined) return txt(v['值']);
      return Object.keys(v).filter(function (k) { return ['depth_level', 'source', 'confidence', 'author', 'verified_at', '排序'].indexOf(k) < 0; })
        .map(function (k) { return txt(v[k]); }).filter(Boolean).join('；');
    }
    return String(v);
  }
  function perCapita(d) {
    var tiers = d && d.B_单产模型 && d.B_单产模型['规模分档KPI基准'];
    if (!Array.isArray(tiers)) return null;
    for (var i = 0; i < tiers.length; i++) {
      var kr = String(tiers[i]['关键比率'] || '');
      var m = kr.match(/人均月产值\s*([\d.]+)\s*[~至-]\s*([\d.]+)/) || kr.match(/全员人均创收\s*([\d.]+)\s*[至~]\s*([\d.]+)/);
      if (m) return { lo: parseFloat(m[1]), hi: parseFloat(m[2]), from: tiers[i]['档位'] || '' };
    }
    return null;
  }

  /* 六维矩阵：已覆盖钩子 + 缺维时的行业派生通用校验式 */
  function sixMatrix(profile) {
    var d = profile.dossier || {};
    var E = d.E_交叉验证 || {};
    var hooks = E.验证钩子 || [];
    var B = d.B_单产模型 || {}, C = d.C_产业链 || {};

    var buckets = {};
    SIX_DIM.forEach(function (s) { buckets[s.k] = []; });
    hooks.forEach(function (h) {
      var k = DIM2SIX[h.dim];
      if (k) buckets[k].push(h);
    });

    var gp = midOf(B['毛利率区间'] || profile.kpi['毛利率区间']);
    var np = midOf(B['净利率区间'] || profile.kpi['净利率区间']);
    var pc = perCapita(d);
    var days = daysOf(txt(C['账期特征']));
    var formula = txt(B['单产公式']);
    var bep = txt(B['盈亏平衡点']);

    var FALLBACK = {
      收入: {
        f: formula ? '月营收推算 = ' + formula.slice(0, 120) : '',
        t: '偏差 ≤20% 正常、20%~40% 黄灯、>40% 红灯',
        b: formula ? '本行业 B 组单产公式' : ''
      },
      产能: {
        f: bep ? '保本营收底线 = ' + bep.slice(0, 120) : '',
        t: '自述营收 ≥ 底线 1.2 倍为正常，低于底线为红灯',
        b: bep ? '本行业 B 组盈亏平衡点' : ''
      },
      存货: {
        f: days ? '存货周转天数 ≤ ' + days + ' 天（超过 1.5 倍即 ' + Math.round(days * 1.5) + ' 天为红灯）' : '',
        t: '≤ 基准正常、1~1.5 倍黄灯、>1.5 倍红灯',
        b: days ? '本行业 C 组账期特征' : ''
      },
      采购: {
        f: gp !== null ? '采购额 ÷ 营收 ≈ 成本率 ' + (100 - gp).toFixed(0) + '%（= 100% − 毛利率中位 ' + gp.toFixed(0) + '%）' : '',
        t: '与成本率偏差 ≤15% 正常、15%~30% 黄灯、>30% 红灯',
        b: gp !== null ? '本行业毛利率区间反推' : ''
      },
      员工: {
        f: pc ? '人效 = 月营收 ÷ 人数，对照 ' + pc.lo + '~' + pc.hi + ' 万元/人/月' : '',
        t: '落在区间内正常，偏离 ±25% 黄灯、±40% 红灯',
        b: pc ? '本行业规模分档「' + pc.from + '」关键比率' : ''
      },
      利润: {
        f: np !== null ? '净利率 = 净利 ÷ 营收，对照 ' + (B['净利率区间'] || profile.kpi['净利率区间']) + '（中位 ' + np.toFixed(1) + '%）' : '',
        t: '落在区间内正常，偏离 ±30% 黄灯、±50% 红灯',
        b: np !== null ? '本行业净利率区间' : ''
      }
    };

    return SIX_DIM.map(function (s) {
      var hs = buckets[s.k];
      var fb = FALLBACK[s.k];
      var hasFormula = hs.some(function (h) { return h.expr; });
      var hasTh = hs.some(function (h) { return h.阈值; });
      var thTxt = [];
      hs.slice(0, 3).forEach(function (h) {
        if (h.阈值) thTxt.push((h.id || '') + ' ok≤' + ((h.阈值.ok !== undefined ? h.阈值.ok : 0.2) * 100).toFixed(0) + '%/warn>' + ((h.阈值.warn !== undefined ? h.阈值.warn : 0.4) * 100).toFixed(0) + '%');
      });
      return {
        k: s.k, desc: s.d,
        n: hs.length,
        names: hs.slice(0, 4).map(function (h) { return h.名称 || h.id || ''; }),
        hasFormula: hasFormula, hasTh: hasTh,
        thTxt: thTxt.join('；'),
        covered: hs.length > 0,
        complete: hs.length > 0 && hasFormula && hasTh,
        fbFormula: fb.f, fbTh: fb.t, fbBasis: fb.b
      };
    });
  }

  /* 六维矩阵 HTML */
  function sixHtml(profile) {
    var rows = sixMatrix(profile);
    var miss = rows.filter(function (r) { return !r.covered; }).length;
    var h = '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:14px;">';
    h += '<div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:4px;">六维证据矩阵' +
      '<span style="font-weight:400;color:#64748b;font-size:12px;margin-left:8px;">收入 / 产能 / 存货 / 采购 / 员工 / 利润 —— 每维都要有公式与阈值，缺维不得据此下结论</span></div>';
    h += '<div style="font-size:12.5px;color:' + (miss ? '#b45309' : '#166534') + ';margin-bottom:10px;">' +
      (miss ? '本行业有 ' + miss + ' 个维度尚无专属校验项，已给出由本行业档案数值派生的通用校验式；档案中确无基准的维度标注「须现场实测」，不套通用常数。'
            : '六维均有本行业专属校验项，公式与阈值齐全。') + '</div>';
    h += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px;">' +
      '<thead><tr style="background:#eef2f7;">' +
      '<th style="padding:7px 9px;text-align:left;">维度</th>' +
      '<th style="padding:7px 9px;text-align:left;">覆盖</th>' +
      '<th style="padding:7px 9px;text-align:left;">本行业公式 / 校验式</th>' +
      '<th style="padding:7px 9px;text-align:left;">阈值</th>' +
      '<th style="padding:7px 9px;text-align:left;">依据</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var bg = r.complete ? '#f0fdf4' : r.covered ? '#fffbeb' : '#fef2f2';
      h += '<tr style="background:' + bg + ';">';
      h += '<td style="padding:7px 9px;font-weight:700;">' + esc(r.k) +
        '<div style="font-weight:400;color:#64748b;font-size:11.5px;">' + esc(r.desc) + '</div></td>';
      h += '<td style="padding:7px 9px;">' + (r.n ? '<b>' + r.n + '</b> 个校验项' : '<b style="color:#dc2626">缺维</b>') +
        (r.names.length ? '<div style="color:#64748b;font-size:11.5px;">' + esc(r.names.join('、')) + '</div>' : '') + '</td>';
      h += '<td style="padding:7px 9px;line-height:1.7;max-width:360px;">' +
        (r.covered ? '本行业专属 expr（' + (r.hasFormula ? '有公式' : '无公式') + '）'
                   : (r.fbFormula ? esc(r.fbFormula) : '<span style="color:#dc2626">本行业未提供基准，须现场实测</span>')) + '</td>';
      h += '<td style="padding:7px 9px;line-height:1.7;">' + esc(r.thTxt || r.fbTh || '—') + '</td>';
      h += '<td style="padding:7px 9px;color:#64748b;font-size:11.5px;">' +
        esc(r.covered ? '本行业 E 组交叉验证配置' : (r.fbBasis || '—')) + '</td>';
      h += '</tr>';
    });
    h += '</tbody></table></div></div>';
    return h;
  }

  return { run: run, renderHtml: renderHtml, collectValues: collectValues, resultHtml: resultHtml,
    inputsOf: inputsOf, badge: badge, sixMatrix: sixMatrix, sixHtml: sixHtml, SIX_DIM: SIX_DIM };
})();
