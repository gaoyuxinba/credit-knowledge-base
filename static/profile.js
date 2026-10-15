/* ==========================================================================
 * 小微行业信贷知识库 · 统一行业装配层 (V10.0)
 * --------------------------------------------------------------------------
 * 解决的问题：
 *   过去「数据看板」读 industries/city_risks，「行业深度档案」读 deepDossier，
 *   两套口径各说各话 —— 看板说毛利率 29%-34%，档案说成本结构已占满 100%。
 *
 * 现在：每个行业编号只装配出**一个** PROFILE 对象，
 *   看板 / 行业分析 / 风险速查 / 城市风控 / 评分卡 / 深度档案 / 搜索 全部读它。
 *   档案存在时，KPI 以档案为准（L3+ 覆盖 L1 主表），并自动登记两者冲突。
 *
 * 依赖：core_taxonomy.js（XWK_TAXO）必须先加载
 * ========================================================================== */
'use strict';

window.XWK_PROFILE = (function () {
  var T = window.XWK_TAXO;

  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }

  /* 解析 "29%-34%" → {lo:29, hi:34, mid:31.5} */
  function pctRange(s) {
    if (!s) return null;
    var m = String(s).replace(/[％\s]/g, '').match(/(-?\d+(?:\.\d+)?)\s*%?\s*[-~至到]\s*(-?\d+(?:\.\d+)?)\s*%?/);
    if (!m) {
      var one = String(s).replace(/[％\s]/g, '').match(/(-?\d+(?:\.\d+)?)\s*%/);
      return one ? { lo: parseFloat(one[1]), hi: parseFloat(one[1]), mid: parseFloat(one[1]) } : null;
    }
    var lo = parseFloat(m[1]), hi = parseFloat(m[2]);
    return { lo: lo, hi: hi, mid: (lo + hi) / 2 };
  }

  /* 解析成本结构（数组 / {值:[...]} / 字符串）各项占比之和 */
  function costSum(costStruct) {
    if (costStruct && typeof costStruct === 'object' && !Array.isArray(costStruct) && Array.isArray(costStruct['值'])) {
      costStruct = costStruct['值'];
    }
    var sum = 0, ok = false;
    if (Array.isArray(costStruct)) {
      costStruct.forEach(function (c) {
        var v = c['占营收比'] || c['占比'] || '';
        var r = pctRange(v);
        if (r) { sum += r.mid; ok = true; }
      });
      return ok ? sum : null;
    }
    if (typeof costStruct === 'string') {
      var re = /(\d+(?:\.\d+)?)\s*%/g, m, n = 0;
      while ((m = re.exec(costStruct)) !== null) { sum += parseFloat(m[1]); n++; }
      return n ? sum : null;
    }
    return null;
  }

  /* ---------------- 勾稽体检：档案 vs 主表，以及档案内部自洽 ---------------- */
  function runChecks(p) {
    var out = [];
    var add = function (id, sev, title, cur, conflict, fix, impact) {
      out.push({ 编号: id, 严重度: sev, 问题: title, 现有值: cur, 矛盾点: conflict, 修正建议: fix, 影响: impact });
    };
    var d = p.dossier;

    // CHK-A 成本结构合计 vs 净利率（档案内部自洽）
    if (d && d.B_单产模型) {
      var cs = costSum(d.B_单产模型.成本结构);
      var np = pctRange(d.B_单产模型.净利率区间);
      if (cs !== null && np && np.lo > 0 && cs >= 98) {
        add('CHK-' + p.code + '-A', '高', '成本结构占满营收却仍报净利为正',
          '成本合计 ' + cs.toFixed(0) + '% ｜ 净利率 ' + (d.B_单产模型.净利率区间 || '—'),
          '各项成本占营收比合计已达 ' + cs.toFixed(0) + '%，理论上利润为 0，与净利率下限 ' + np.lo + '% 直接冲突',
          '把成本结构改为「占营收比」口径下的营业成本口径（不含税费与折旧），或下调成本占比至合计 ≤ (100% - 净利率)，并同步修正依赖该口径的校验项',
          '成本口径错误会系统性低估保本线，导致保本线校验（H8 类校验项）与净利倒推同时失真');
      }
      var gp = pctRange(d.B_单产模型.毛利率区间);
      if (gp && np && np.hi > gp.hi) {
        add('CHK-' + p.code + '-B', '高', '净利率上限高于毛利率上限',
          '毛利 ' + (d.B_单产模型.毛利率区间 || '—') + ' ｜ 净利 ' + (d.B_单产模型.净利率区间 || '—'),
          '净利率不可能高于毛利率',
          '核对两项口径：毛利率应为（营收-营业成本）/营收，净利率为扣除人工、房租、能耗、折旧、税费后的口径',
          '净利倒推与 DSCR 计算会高估还款能力');
      }
      // CHK-C 档案 KPI vs 主表 KPI
      var baseGp = pctRange(p.base['毛利率区间']);
      if (baseGp && gp && Math.abs(baseGp.mid - gp.mid) >= 8) {
        add('CHK-' + p.code + '-C', '中', '档案毛利率与行业主表毛利率偏离 ≥8 个百分点',
          '主表 ' + (p.base['毛利率区间'] || '—') + ' ｜ 档案 ' + (d.B_单产模型.毛利率区间 || '—'),
          '中位值相差 ' + Math.abs(baseGp.mid - gp.mid).toFixed(1) + ' 个百分点',
          '以档案（L' + p.depth.slice(1) + '，经核验）为准，回写行业主表；主表数值保留为「原始值」备查',
          '看板与档案口径不一致，会出现同一行业两个毛利率');
      }
    }

    // CHK-D 主表成本结构与毛利率冲突
    var baseCs = costSum(p.base['成本结构']);
    var baseGp2 = pctRange(p.base['毛利率区间']);
    if (baseCs !== null && baseGp2 && (100 - baseCs) < baseGp2.lo - 3) {
      add('CHK-' + p.code + '-D', '中', '行业主表成本结构与毛利率不自洽',
        '成本合计约 ' + baseCs.toFixed(0) + '% ｜ 毛利率 ' + (p.base['毛利率区间'] || '—'),
        '(100% - 成本) = ' + (100 - baseCs).toFixed(0) + '%，低于毛利率下限 ' + baseGp2.lo + '%',
        '主表成本结构为旧口径粗估，已由档案成本结构覆盖；建议在下一批数据维护中回写',
        '主表成本不可单独用于保本测算');
    }

    // CHK-E 城市风险覆盖缺失
    if (p.isIndustry && p.cityRisks.length === 0) {
      add('CHK-' + p.code + '-E', '中', '该行业无任何城市风险记录', '0 条',
        '城市风控页与看板对该行业无城市维度数据', '按城市档案规则重新生成，或明确标注为「暂不覆盖」', '城市维度不可用');
    }

    // CHK-F 岗位缺失
    if (p.isIndustry && p.jobs.length === 0) {
      add('CHK-' + p.code + '-F', '低', '该行业无岗位记录', '0 条', '岗位核验无法进行', '补充至少 3 个核心岗位', '岗位核验不可用');
    }

    // CHK-G 旺季与淡季月份重叠
    var hot = (p.base['旺季月份'] || '').split(/[,，、]/).map(function (s) { return s.trim(); }).filter(Boolean);
    var cold = (p.base['淡季月份'] || '').split(/[,，、]/).map(function (s) { return s.trim(); }).filter(Boolean);
    var overlap = hot.filter(function (m) { return cold.indexOf(m) >= 0; });
    if (overlap.length) {
      add('CHK-' + p.code + '-G', '低', '旺季与淡季月份重叠', overlap.join('、'),
        '同一月份既标旺又标淡', '明确该月归属，或细分为上旬/下旬', '季节性资金缺口判断会自相矛盾');
    }

    // CHK-H 风险层级在原库与统一口径下不一致
    if (p.risk && p.risk.reclassified > 0) {
      add('CHK-' + p.code + '-H', '低', '城市风险层级按统一口径重算后有变化',
        p.risk.reclassified + ' / ' + p.cityRisks.length + ' 条被重算',
        '原库 A≤30 / B30-50 / C46-70 / D66-95 存在 46-50 与 66-70 两段重叠',
        '已按统一口径（A≤30｜B31-50｜C51-70｜D71-100）重算，原值保留为 风险层级_原始',
        '消除同分不同级，保证看板与风险速查口径一致');
    }
    return out;
  }

  /* ---------------- 装配单个行业 ---------------- */
  function buildOne(code, ctx) {
    var base = ctx.indByCode[code] || {};
    var dossier = ctx.dossierByCode[code] || null;
    var tier = T.tierOf(code);
    var isIndustry = tier !== 'NA';

    var modes = ctx.modesByCode[code] || [];
    var jobs = ctx.jobsByCode[code] || [];
    var cityRisks = ctx.risksByCode[code] || [];
    var salary = {};
    jobs.forEach(function (j) {
      var k = code + '|' + j['常见职位'];
      if (ctx.salary[k]) salary[j['常见职位']] = ctx.salary[k];
    });

    /* 城市风险：按统一口径重算层级 */
    var cityBy = {}, dist = { A: 0, B: 0, C: 0, D: 0 }, reclassified = 0, scoreSum = 0, hiCity = null, loCity = null;
    cityRisks.forEach(function (r) {
      var sc = num(r['风险评分']);
      var lv0 = r['风险层级'];
      var lv = T.riskLevelOf(sc);
      if (lv0 !== undefined && lv0 !== null && String(lv0) !== String(lv)) reclassified++;
      if (String(lv0) !== String(lv)) r['风险层级_原始'] = lv0;
      r['风险层级'] = lv;
      r['derived'] = true;
      r['derived_from'] = '行业母表 × 城市母表（模型派生，非独立研究）';
      cityBy[r['城市']] = { score: sc, lv: lv, 原始层级: lv0 };
      if (dist[lv] !== undefined) dist[lv]++;
      if (sc !== null) {
        scoreSum += sc;
        if (!hiCity || sc > hiCity.score) hiCity = { city: r['城市'], score: sc, lv: lv };
        if (!loCity || sc < loCity.score) loCity = { city: r['城市'], score: sc, lv: lv };
      }
    });
    var scoreAvg = cityRisks.length ? Math.round(scoreSum / cityRisks.length * 10) / 10 : null;

    var depth = T.depthOf(dossier);

    /* KPI：档案（L2+）优先，否则主表 */
    var kpi = {
      毛利率区间: (dossier && dossier.B_单产模型 && dossier.B_单产模型.毛利率区间) || base['毛利率区间'] || '',
      净利率区间: (dossier && dossier.B_单产模型 && dossier.B_单产模型.净利率区间) || base['净利率区间'] || '',
      旺季月份: base['旺季月份'] || '',
      淡季月份: base['淡季月份'] || '',
      资金缺口高峰: base['季节性资金缺口高峰'] || '',
      成本结构: (dossier && dossier.B_单产模型 && dossier.B_单产模型.成本结构) || base['成本结构'] || '',
      单产公式: (dossier && dossier.B_单产模型 && dossier.B_单产模型.单产公式) || '',
      盈亏平衡点: (dossier && dossier.B_单产模型 && dossier.B_单产模型.盈亏平衡点) || '',
      来源: (dossier && depth !== 'L1') ? '深度档案' : '行业主表'
    };

    var conf = 'derived';
    if (dossier) {
      conf = (dossier.meta && dossier.meta.confidence) || (depth === 'L4' ? 'high' : depth === 'L3' ? 'mid' : 'low');
    } else if (modes.length >= 3) conf = 'mid';
    else conf = 'low';

    var p = {
      code: code,
      cat: base['行业大类'] || '',
      name: base['细分行业'] || code,
      isIndustry: isIndustry,
      tier: tier,
      depth: depth,
      confidence: conf,
      base: base,
      modes: modes,
      jobs: jobs,
      salary: salary,
      cityRisks: cityRisks,
      cityBy: cityBy,
      dossier: dossier,
      kpi: kpi,
      risk: {
        scoreAvg: scoreAvg,
        level: T.riskLevelOf(scoreAvg),
        dist: dist,
        worstCity: hiCity,
        bestCity: loCity,
        reclassified: reclassified
      },
      hooks: (dossier && dossier.E_交叉验证 && dossier.E_交叉验证.验证钩子) ? dossier.E_交叉验证.验证钩子 : [],
      verifiedAt: (dossier && dossier.meta && dossier.meta.verified_at) || '',
      units: dossier ? T.countUnits(dossier) : 0,
      checks: []
    };
    p.checks = runChecks(p);
    return p;
  }

  /* ------------------------------------------------------------------
   * 回写：把档案的权威数值写回行业主表对象本身
   *
   * 这是「看板与深度档案保持一致」的落点。站内大量页面（数据看板、
   * 行业分析、全局搜索、评分卡、CSV 导出）是直接读行业主表字段的；
   * 只让装配层 prof() 拿到档案值，这些页面仍然是两套数。
   * 因此在装配时把档案值原地写回主表，原值保留在 `xxx_原始`。
   *
   * 只回写纯字符串字段 —— 成本结构在评分模型里按字符串解析，
   * 写入数组（档案里是对象数组）会直接把评分卡算崩，故不回写。
   * ------------------------------------------------------------------ */
  var SYNC_FIELDS = ['毛利率区间', '净利率区间'];

  /* ------------------------------------------------------------------
   * 行业主表里有 5 个字段是当年套话批量填的：170 个行业只用了 12 种取值，
   * 156 个行业共用同一句（"营业执照 + 行业相关资质许可证" /
   * "线上推广+线下拓展+老客户转介绍" / "市场竞争加剧、成本上升、人才流失、政策变化" …）。
   * 这些字段被行业详情、行业对比、全局搜索、CSV 导出、评分卡直接读取，
   * 套话会被当成核实过的结论引用。档案里已有逐行业核实过的内容，这里按字段回写。
   * 档案没有对应内容的字段一律留空 —— 宁可留白，不回填套话。
   * ------------------------------------------------------------------ */
  var META_K = ['depth_level', 'source', 'confidence', 'author', 'verified_at', '排序'];

  function flatText(v) {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (Array.isArray(v)) {
      return v.map(function (x) { return flatText(x); }).filter(Boolean).join('；');
    }
    if (typeof v === 'object') {
      if (v['值'] !== undefined) return flatText(v['值']);
      return Object.keys(v).filter(function (k) { return META_K.indexOf(k) < 0; })
        .map(function (k) { return k + '：' + flatText(v[k]); }).join('；');
    }
    return String(v);
  }

  function clip(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').replace(/\*\*/g, '').trim();
    if (n <= 0) return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  /* 必备证照资质 ← A_准入.证照清单 */
  function fromLicense(d) {
    var arr = d.A_准入 && d.A_准入.证照清单;
    if (!Array.isArray(arr)) return '';
    return arr.slice(0, 6).map(function (x) {
      var n = x['证照'] || '';
      var t = x['触发条件'] ? String(x['触发条件']).replace(/\*\*/g, '') : '';
      return t && t !== '—' ? n + '（' + t + '）' : n;
    }).filter(Boolean).join('；');
  }

  /* 主要经营风险 ← D_失败与包装.Top失败原因（带早期信号，可直接用于现场） */
  function fromFail(d) {
    var arr = d.D_失败与包装 && d.D_失败与包装['Top失败原因'];
    if (!Array.isArray(arr)) return '';
    return arr.slice(0, 4).map(function (x) {
      var r = x['原因'] || '';
      var s = x['早期信号'] ? String(x['早期信号']).replace(/\*\*/g, '') : '';
      return r ? r + (s ? '（早期信号：' + s + '）' : '') : '';
    }).filter(Boolean).join('；');
  }

  /* 典型融资用途 ← F_额度与用途.合理融资规模（多数档案是整段文字，少数是分用途数组） */
  function fromFund(d) {
    var v = d.F_额度与用途 && d.F_额度与用途['合理融资规模'];
    if (!v) return '';
    if (Array.isArray(v)) {
      return v.slice(0, 4).map(function (x) {
        var u = x['用途'] || '';
        var m = x['测算'] || '';
        return u ? u + (m ? '（' + m + '）' : '') : '';
      }).filter(Boolean).join('；');
    }
    return clip(flatText(v), 260);
  }

  /* 订单与客户来源 ← C_产业链.下游结构 */
  function fromDownstream(d) {
    var v = d.C_产业链 && d.C_产业链['下游结构'];
    if (!v) return '';
    return clip(flatText(v), 220);
  }

  /* 政策与外部驱动 ← A_准入.准入负面清单（监管禁止项）+ C_产业链.平台或加盟依赖风险
     这两项是这个行业真正的外部变量：政策一变就不让干，平台一调就抽走利润 */
  function fromExternal(d) {
    var seg = [];
    var neg = d.A_准入 && d.A_准入['准入负面清单'];
    if (Array.isArray(neg)) {
      var items = neg.slice(0, 3).map(function (x) {
        return typeof x === 'object' ? (x['情形'] || x['条件'] || '') : String(x);
      }).filter(Boolean);
      if (items.length) seg.push('监管禁止：' + items.join('；'));
    } else if (neg) {
      seg.push(clip(flatText(neg), 150));
    }
    var plat = d.C_产业链 && d.C_产业链['平台或加盟依赖风险'];
    if (plat) seg.push(clip(flatText(plat), 110));
    return seg.filter(Boolean).join('；');
  }

  /* 典型经营主体形态 ← 经营模式表里的细分模式（743 条逐条撰写，骨架唯一率 98%）
     原值是「各类 + 行业名 + 企业」套出来的，166 个行业各不相同但没有任何信息量 */
  function fromMode(d, p) {
    var ms = (p && p.modes) || [];
    var s = ms.slice(0, 4).map(function (m) { return m['细分模式'] || ''; })
      .filter(Boolean).join('、');
    if (s) return s;
    /* 该行业没有经营模式表时，退到档案的规模分档档位（有真实人数与营收描述），
       不要退回主表里「各类 + 行业名 + 企业」的套话 */
    var tiers = d && d.B_单产模型 && d.B_单产模型['规模分档KPI基准'];
    if (Array.isArray(tiers) && tiers.length) {
      return tiers.slice(0, 3).map(function (t) { return t['档位'] || ''; })
        .filter(Boolean).join('、');
    }
    return '';
  }

  var BACK_FIELDS = [
    ['必备证照资质', fromLicense, 240],
    ['主要经营风险', fromFail, 320],
    ['典型融资用途', fromFund, 260],
    ['订单与客户来源', fromDownstream, 240],
    ['政策与外部驱动', fromExternal, 260],
    ['典型经营主体形态', fromMode, 140]
  ];

  /* 「前景趋势判断」没有档案对应内容，原值是 31 句套话覆盖 170 个行业。
     不按字段清单统一清空，而是按「全库共用程度」判定：同一句话被 ≥10 个
     行业共用 → 判为套话，留白；逐行业核实过的真实值一律保留。这样后面
     补齐的真实内容不会被一刀切清掉。 */
  var FILLER_MIN = 10;   // 同一取值被多少个行业共用即判为套话

  function fillerSet(rows, field) {
    var cnt = {}, out = {};
    rows.forEach(function (r) {
      var v = String(r[field] || '').trim();
      if (!v) return;
      cnt[v] = (cnt[v] || 0) + 1;
    });
    Object.keys(cnt).forEach(function (v) { if (cnt[v] >= FILLER_MIN) out[v] = cnt[v]; });
    return out;
  }

  function syncBack(p) {
    /* 非授信条目（政府 / 通用岗位库）不参与授信判断，套话字段一律清空 */
    if (!p.isIndustry) {
      BACK_FIELDS.forEach(function (spec) {
        var f = spec[0];
        if (p.base[f]) { p.base[f + '_原始'] = p.base[f]; p.base[f] = ''; }
      });
      return;
    }
    if (!p.dossier || p.depth === 'L1') return;
    SYNC_FIELDS.forEach(function (f) {
      var v = p.kpi[f];
      if (!v) return;
      var cur = p.base[f];
      if (String(cur) === String(v)) return;
      p.base[f + '_原始'] = cur;
      p.base[f] = v;
    });

    /* 套话字段：能取到档案真实内容就回写，取不到就留空 */
    BACK_FIELDS.forEach(function (spec) {
      var f = spec[0], fn = spec[1], max = spec[2];
      var v = '';
      try { v = clip(fn(p.dossier, p), max); } catch (e) { v = ''; }
      var cur = String(p.base[f] || '').trim();
      if (!v) {
        /* 档案没有这块内容 —— 原值是套话，不保留 */
        if (cur) { p.base[f + '_原始'] = cur; p.base[f] = ''; }
        return;
      }
      if (cur === v) return;
      if (cur) p.base[f + '_原始'] = cur;
      p.base[f] = v;
    });

    /* 前景趋势判断：只在确认是套话时才留白，真实值保留 */
    var ff = '前景趋势判断';
    var curF = String(p.base[ff] || '').trim();
    if (curF && p.__fillerF && p.__fillerF[curF]) {
      p.base[ff + '_原始'] = curF;
      p.base[ff] = '';
    }
  }

  /* ------------------------------------------------------------------
   * 城市维度基准（全站城市展示的唯一来源）
   *
   * 城市这一层（租金 / 人工 / 消费力）是已经核实过的 city_factors；
   * 行业×城市只在少数城市做过独立研究，其余城市不给结论，只给换算基准。
   * 「小微行业看板」「小微行业交叉验证看板」「数据看板」「城市分析」
   * 「城市风控」全部调这里，保证口径一致。
   * ------------------------------------------------------------------ */
  function median(arr) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    if (!a.length) return 1;
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function cityBench(db, cities) {
    var cf = (db && db.city_factors) || {};
    var all = Object.keys(cf);
    if (!all.length) return null;
    var names = cities && cities.length
      ? all.filter(function (c) { return cities.indexOf(c) >= 0; })
      : all.slice();
    if (!names.length) return null;

    var rentBase = median(all.map(function (n) { return cf[n].rent_factor || 1; }));
    var salBase = median(all.map(function (n) { return cf[n].salary_factor || 1; }));
    var tags = {};
    ((db && db.cities) || []).forEach(function (c) { if (c['城市名称']) tags[c['城市名称']] = c['定位标签'] || ''; });

    var rows = names.map(function (n) {
      var f = cf[n] || {};
      var rf = f.rent_factor || 1, sf = f.salary_factor || 1;
      return {
        城市: n,
        定位: f.tag || tags[n] || '',
        经济水平: f.economic_level,
        租金系数: rf, 租金倍数: rf / rentBase,
        成本系数: f.cost_factor,
        薪资系数: sf, 薪资倍数: sf / salBase,
        购买力: f.purchasing_power
      };
    }).sort(function (a, b) { return b.租金系数 - a.租金系数; });

    return { rows: rows, rentBase: rentBase, salBase: salBase, count: rows.length, total: all.length };
  }

  /* ------------------------------------------------------------------
   * 3400 条「行业×城市」记录里的 5 个文本字段是当年用「行业名 + 城市名 + 句式模板」
   * 批量拼出来的：换一个城市只换名字，结论不随城市变（扫描确认骨架重复率 97%+）。
   * 这些文字一旦进搜索、导出或页面，就会被当成核实过的结论引用，因此在装配前直接下线。
   * 城市维度改由 cityMatrix() 按「行业成本基准 × 城市系数」实时算出。
   * ------------------------------------------------------------------ */
  var CITY_TEMPLATE_FIELDS = ['行业优势', '主要风险点', '风控建议', '依据与尽调要点', '行业风险'];
  function dropCityTemplate(rows) {
    if (!Array.isArray(rows)) return rows;
    rows.forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      CITY_TEMPLATE_FIELDS.forEach(function (f) { delete r[f]; });
    });
    return rows;
  }

  /* ------------------------------------------------------------------
   * 从行业成本结构里挑出「房租」「人工」两个可换算科目
   * 混合科目（如「商场扣点与门店租金」）不参与，否则换算出的数据不可解释
   * ------------------------------------------------------------------ */
  function costBasis(p) {
    var cs = (p && p.kpi) ? p.kpi.成本结构 : null;
    var arr = [];
    if (Array.isArray(cs)) arr = cs;
    else if (cs && typeof cs === 'object' && Array.isArray(cs['值'])) arr = cs['值'];
    var rent = null, labor = null;
    arr.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var name = String(it['科目'] || it['项目'] || '');
      var ratio = it['占营收比'] || it['占比'] || '';
      if (!name || !ratio) return;
      var core = name.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');
      if (/[、，,与及或\/]/.test(core)) return;
      var r = pctRange(ratio);
      if (!r) return;
      if (!rent && /房租|租金|铺租|场地租金/.test(core)) rent = { 名称: name, 占比: ratio, lo: r.lo, hi: r.hi, mid: r.mid };
      if (!labor && /人工|人力|薪酬|工资/.test(core)) labor = { 名称: name, 占比: ratio, lo: r.lo, hi: r.hi, mid: r.mid };
    });
    return { rent: rent, labor: labor, has: !!(rent || labor) };
  }

  /* ------------------------------------------------------------------
   * 行业 × 城市矩阵（数据看板「城市风险分级」与深度档案 H 组的唯一来源）
   *
   * 背景：库里原有 3400 条「行业×城市风险」是行业名 + 城市名 + 句式模板拼出来的，
   *       换城市只换名字，结论不随城市变，属不可用数据。
   *
   * 现在的做法：城市这一层只取已核实的 city_factors（租金 / 人工 / 成本 / 购买力），
   * 行业这一层只取已核实的成本结构与行业基准风险分，两者**算**出城市维度结论。
   * 每一格都能说清是怎么来的，口径写在页面上。
   *
   * 风险分口径：
   *   成本指数 = 城市综合成本系数 ÷ 23 城中位
   *   购买力指数 = 城市薪资购买力 ÷ 23 城中位
   *   城市风险分 = 行业基准分 + (成本指数-1)×100×0.30 + (1-购买力指数)×100×0.20
   *   即：成本高出中位 10% → +3.0 分；购买力低于中位 10% → +2.0 分。
   * ------------------------------------------------------------------ */
  var RISK_W_COST = 0.30, RISK_W_DEMAND = 0.20;

  function cityMatrix(p, db, cities) {
    var bench = cityBench(db, cities);
    if (!bench || !bench.rows.length) return null;

    var cf = (db && db.city_factors) || {};
    var all = Object.keys(cf);
    var costBase = median(all.map(function (n) { return cf[n].cost_factor || 1; }));
    var ppBase = median(all.map(function (n) { return cf[n].purchasing_power || 1; }));

    var basis = costBasis(p);
    var baseScore = (p && p.risk && p.risk.scoreAvg != null) ? p.risk.scoreAvg : null;

    var rows = bench.rows.map(function (r) {
      var f = cf[r.城市] || {};
      var costIdx = (f.cost_factor || 1) / costBase;
      var ppIdx = (f.purchasing_power || 1) / ppBase;

      var o = {
        城市: r.城市, 定位: r.定位, 经济水平: r.经济水平,
        租金系数: r.租金系数, 租金倍数: r.租金倍数,
        成本系数: r.成本系数, 薪资系数: r.薪资系数, 薪资倍数: r.薪资倍数,
        购买力: r.购买力,
        成本指数: Math.round(costIdx * 1000) / 1000,
        购买力指数: Math.round(ppIdx * 1000) / 1000,
        产业匹配: matchIndustry(r.定位, p),
        风险评分: null, 风险层级: '—', 成本加减分: null
      };

      if (basis.rent) {
        o.房租占比 = basis.rent.mid * r.租金倍数;
        o.房租占比区间 = (basis.rent.lo * r.租金倍数).toFixed(1) + '% ~ ' + (basis.rent.hi * r.租金倍数).toFixed(1) + '%';
      }
      if (basis.labor) {
        o.人工占比 = basis.labor.mid * r.薪资倍数;
        o.人工占比区间 = (basis.labor.lo * r.薪资倍数).toFixed(1) + '% ~ ' + (basis.labor.hi * r.薪资倍数).toFixed(1) + '%';
      }
      if (basis.rent && basis.labor) {
        /* 房租 + 人工 = 固定成本主体，是授信判断「扛不扛得住」最关键的一个数 */
        o.固定成本合计 = basis.rent.mid * r.租金倍数 + basis.labor.mid * r.薪资倍数;
      }

      if (baseScore != null) {
        var dc = (costIdx - 1) * 100 * RISK_W_COST;
        var dd = (1 - ppIdx) * 100 * RISK_W_DEMAND;
        var sc = baseScore + dc + dd;
        sc = Math.max(0, Math.min(100, Math.round(sc * 10) / 10));
        o.风险评分 = sc;
        o.风险层级 = T.riskLevelOf(sc);
        o.成本加减分 = Math.round((dc + dd) * 10) / 10;
      }
      return o;
    });

    var scores = rows.filter(function (r) { return r.风险评分 != null; });
    scores.sort(function (a, b) { return b.风险评分 - a.风险评分; });

    return {
      rows: rows,
      basis: basis,
      baseScore: baseScore,
      costBase: costBase, ppBase: ppBase,
      total: bench.total,
      worst: scores.length ? scores[0] : null,
      best: scores.length ? scores[scores.length - 1] : null,
      dist: (function () {
        var d = { A: 0, B: 0, C: 0, D: 0 };
        rows.forEach(function (r) { if (d[r.风险层级] !== undefined) d[r.风险层级]++; });
        return d;
      })(),
      formula: '城市风险分 = 行业基准分 +（成本指数−1）×100×' + RISK_W_COST +
        ' +（1−购买力指数）×100×' + RISK_W_DEMAND
    };
  }

  /* 城市产业定位与本行业的比对：只做关键词比对，不给准入结论 */
  var CITY_STOP = /^(城市|地区|中心|名城|重镇|之都|门户|基地|枢纽|强市|首府|先锋|经济|制造|科创|商贸|港口|海洋|西部|中部|东北|北方|海西|山东|中原|西北)/;
  function matchIndustry(tag, p) {
    if (!tag || !p) return { lv: '—', hits: [] };
    var t = String(tag).replace(/^[^：:]*[：:]/, '');
    var parts = t.split(/[\/、，,]/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length >= 2; });
    var ind = String(p.name || '') + '/' + String(p.cat || '');
    var indWords = ind.split(/[\/、，,]/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length >= 2; });
    var hits = [];
    parts.forEach(function (w) {
      indWords.forEach(function (iw) {
        if (iw.indexOf(w) >= 0 || w.indexOf(iw) >= 0) { if (hits.indexOf(w) < 0) hits.push(w); }
      });
    });
    var lv = hits.length ? '产业相关' : (/制造|工业|装备/.test(t) && /制造|工业|装备/.test(ind) ? '大类相关' : '无直接对应');
    return { lv: lv, hits: hits };
  }

  /* ------------------------------------------------------------------
   * V12.0：城市调研层 —— 行业 × 城市 的**逐条查证**结论（不再是模板拼接）
   *
   * 背景：3400 条 city_risks 的文字是「行业名 + 城市名 + 句式模板」拼的，已下线；
   *       V11.2 的 cityMatrix 用「行业成本基准 × 城市系数」算，方向对但没落地细节；
   *       V12.0 起，每个行业在每个城市都做实地口径的查证：门店数 / 政策 / 租金实测 /
   *       岗位薪资 / 官方可查渠道 / 本行业特有的核验动作，逐条带来源与核实时间。
   *
   * 输出给页面的是 cards：数值部分（系数、风险分）来自 cityMatrix 的可复算口径，
   * 文字部分（优势 / 风险 / 成本实况 / 尽调要点）来自联网查证的调研稿。
   * 没调研到的城市照旧给换算基准，并明确标注「未调研」，不冒充结论。
   * ------------------------------------------------------------------ */
  /* 来源归一化：城市调研里「来源」既有数组写法（逐条带标题与日期），
   * 也有用「、」/「；」连写的字符串写法。渲染层按数组遍历，这里统一成数组，
   * 避免字符串被当成字符数组逐个拆开、或因没有 map 直接抛错。 */
  function normSrc(s) {
    if (!s) return [];
    if (Array.isArray(s)) return s.filter(function (x) { return x && String(x).trim(); });
    var t = String(s);
    var parts = t.split(/[；;]|\s*[、]\s*/).map(function (x) { return x.trim(); }).filter(Boolean);
    return parts.length ? parts : (t.trim() ? [t.trim()] : []);
  }

  function cityCards(p, db, cities) {
    var M = cityMatrix(p, db, cities);
    if (!M) return null;

    var CR = (db && db.cityResearch) || null;
    var ind = (CR && CR['行业调研']) ? CR['行业调研'][p.code] : null;
    var res = (ind && ind['城市调研']) || {};

    var cards = M.rows.map(function (r) {
      var y = res[r.城市];
      var c = {
        城市: r.城市, 定位: r.定位,
        租金系数: r.租金系数, 租金倍数: r.租金倍数,
        成本系数: r.成本系数, 薪资系数: r.薪资系数, 薪资倍数: r.薪资倍数,
        购买力: r.购买力, 成本指数: r.成本指数, 购买力指数: r.购买力指数,
        房租占比: r.房租占比, 人工占比: r.人工占比, 固定成本合计: r.固定成本合计,
        风险评分: r.风险评分, 风险层级: r.风险层级, 成本加减分: r.成本加减分,
        已调研: !!y,
        产业匹配: (y && y['产业匹配'])
          ? { 档: y['产业匹配']['档'], 依据: y['产业匹配']['依据'] || '', 来源: '逐城查证' }
          : { 档: null, lv: r.产业匹配.lv, hits: r.产业匹配.hits, 来源: '定位关键词比对' },
        本地优势: (y && y['本地优势']) || [],
        本地风险: (y && y['本地风险']) || [],
        城市前景影响: (y && y['城市前景影响']) || '',
        成本实况: (y && y['成本实况']) || null,
        尽调要点: (y && y['尽调要点']) || [],
        来源: normSrc(y && y['来源']),
        核实时间: (y && y['核实时间']) || '',
        置信度: (y && y['置信度']) || ''
      };
      return c;
    });

    /* 已调研的排前面 —— 信贷员先看有实地口径的城市 */
    cards.sort(function (a, b) {
      if (a.已调研 !== b.已调研) return a.已调研 ? -1 : 1;
      return (b.风险评分 == null ? -1 : b.风险评分) - (a.风险评分 == null ? -1 : a.风险评分);
    });

    var done = cards.filter(function (c) { return c.已调研; });

    return {
      行业编号: p.code, 行业名称: p.name,
      cards: cards,
      调研城数: done.length, 总城数: cards.length,
      hasResearch: done.length > 0,
      basis: M.basis, baseScore: M.baseScore, formula: M.formula,
      dist: M.dist, worst: M.worst, best: M.best,
      basisText: (M.basis.rent ? M.basis.rent.名称 + ' ' + M.basis.rent.占比 : '') +
        (M.basis.rent && M.basis.labor ? '　｜　' : '') +
        (M.basis.labor ? M.basis.labor.名称 + ' ' + M.basis.labor.占比 : '')
    };
  }

  /* ------------------------------------------------------------------
   * V12.0：城市主表 —— 三张表合成一份，键名沿用老 DB.cities，
   * 所以 20 多处读 DB.cities 的页面一行都不用改，却同时拿到了系数与画像。
   *   原 DB.cities        → 城市名称 / 定位标签 / GDP / 人口 / 人均可支配收入 / 城镇化率
   *   原 DB.city_factors  → 城市系数（租金 / 成本 / 薪资 / 购买力）
   *   第 0 批城市调研      → 画像（主导产业 / 园区 / 商铺租金 / 用工 / 监管 / 可查渠道 / 信贷环境）
   * 只保留 DB.city_factors 供 cityBench() 按名字查系数，新代码一律用主表。
   * ------------------------------------------------------------------ */
  function cityMaster(db) {
    var cf = (db && db.city_factors) || {};
    var orig = {};
    ((db && db.cities) || []).forEach(function (c) {
      var n = c['城市名称'] || c['城市'];
      if (n) orig[n] = c;
    });
    var CR = (db && db.cityResearch) || null;
    var pics = (CR && CR['城市画像']) || {};
    var names = (CR && Array.isArray(CR['城市']) && CR['城市'].length)
      ? CR['城市']
      : (Object.keys(cf).length ? Object.keys(cf) : Object.keys(orig));

    var rows = names.map(function (n) {
      var base = orig[n] || {};
      var row = {};
      for (var k in base) row[k] = base[k];
      row['城市名称'] = n;                 // 老表两套键名混用，这里统一
      row['城市系数'] = cf[n] || {};        // 原 city_factors 那一份，按名内嵌
      row['画像'] = pics[n] || null;        // 第 0 批调研画像
      row['已画像'] = !!pics[n];
      return row;
    });

    var byName = {};
    rows.forEach(function (r) { byName[r['城市名称']] = r; });
    return { rows: rows, byName: byName, count: rows.length };
  }

  /* ---------------- 全库装配 ---------------- */
  function build(DB) {
    var ctx = { indByCode: {}, modesByCode: {}, jobsByCode: {}, risksByCode: {}, dossierByCode: {}, salary: DB.salary || {} };
    (DB.industries || []).forEach(function (r) { ctx.indByCode[r['行业编号']] = r; });
    (DB.modes || []).forEach(function (r) { (ctx.modesByCode[r['行业编号']] = ctx.modesByCode[r['行业编号']] || []).push(r); });
    (DB.jobs || []).forEach(function (r) { (ctx.jobsByCode[r['行业编号']] = ctx.jobsByCode[r['行业编号']] || []).push(r); });
    (DB.city_risks || []).forEach(function (r) { (ctx.risksByCode[r['行业编号']] = ctx.risksByCode[r['行业编号']] || []).push(r); });
    var DD = DB.deepDossier || {};
    for (var k in DD) { if (k !== 'meta') ctx.dossierByCode[k] = DD[k]; }

    /* 装配前先算出「前景趋势判断」的套话集合（同句被 ≥10 个行业共用） */
    var fillerF = fillerSet(DB.industries || [], '前景趋势判断');

    var byCode = {}, list = [];
    Object.keys(ctx.indByCode).sort().forEach(function (code) {
      var p = buildOne(code, ctx);
      p.__fillerF = fillerF;
      byCode[code] = p;
      list.push(p);
      syncBack(p);
      delete p.__fillerF;
    });

    /* 全库统计 */
    var stats = {
      total: list.length,
      industryCount: list.filter(function (p) { return p.isIndustry; }).length,
      nonLendingCount: list.filter(function (p) { return !p.isIndustry; }).length,
      dossierCount: list.filter(function (p) { return p.dossier; }).length,
      depthDist: { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 },
      tierDist: { P0: 0, P1: 0, P2: 0, NA: 0 },
      riskDist: { A: 0, B: 0, C: 0, D: 0 },
      hookCount: 0,
      checkCount: 0,
      highChecks: 0,
      units: 0,
      reclassifiedTotal: 0
    };
    list.forEach(function (p) {
      stats.depthDist[p.depth] = (stats.depthDist[p.depth] || 0) + 1;
      stats.tierDist[p.tier] = (stats.tierDist[p.tier] || 0) + 1;
      stats.riskDist[p.risk.level] = (stats.riskDist[p.risk.level] || 0) + 1;
      stats.hookCount += p.hooks.length;
      stats.checkCount += p.checks.length;
      stats.highChecks += p.checks.filter(function (c) { return c.严重度 === '高'; }).length;
      stats.units += p.units;
      stats.reclassifiedTotal += p.risk.reclassified;
    });

    /* 全库勾稽问题汇总（供勾稽看板使用） */
    var allChecks = [];
    list.forEach(function (p) {
      p.checks.forEach(function (c) { allChecks.push({ code: p.code, name: p.name, tier: p.tier, c: c }); });
    });
    var sevOrder = { 高: 0, 中: 1, 低: 2 };
    allChecks.sort(function (a, b) { return (sevOrder[a.c.严重度] - sevOrder[b.c.严重度]) || a.code.localeCompare(b.code); });

    /* V12.0：城市调研层覆盖情况（供页面标注「哪些城市有实地口径」） */
    var CR = DB.cityResearch || null;
    var crInd = (CR && CR['行业调研']) || {};
    var crCells = 0, crFull = 0;
    Object.keys(crInd).forEach(function (code) {
      var n = Object.keys(crInd[code]['城市调研'] || {}).length;
      crCells += n;
      if (n >= 23) crFull++;
    });
    var cityStat = {
      有调研层: !!CR,
      城市数: (CR && CR['城市'] && CR['城市'].length) || 0,
      有画像: Object.keys((CR && CR['城市画像']) || {}).length,
      覆盖行业: Object.keys(crInd).length,
      条目数: crCells,
      全量行业: crFull,
      口径: (CR && CR['meta'] && CR['meta']['口径']) || ''
    };

    return {
      byCode: byCode, list: list, stats: stats, allChecks: allChecks, meta: DD.meta || null,
      city: cityMaster(DB), cityStat: cityStat
    };
  }

  return {
    build: build, pctRange: pctRange, costSum: costSum,
    cityBench: cityBench, cityMatrix: cityMatrix, costBasis: costBasis,
    cityCards: cityCards, cityMaster: cityMaster,
    matchIndustry: matchIndustry, median: median, dropCityTemplate: dropCityTemplate
  };
})();
