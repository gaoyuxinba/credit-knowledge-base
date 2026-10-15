/* ==================================================================
 * 全库字段一致性体检（B8）
 *
 * 体检对象：151 个授信行业（19 个 GN/GV 国防军工类 tier=NA 不纳入信贷调研）
 * 五个维度：① 主表必填字段完整性 ② 三要素（source/confidence/verified_at）
 *          ③ 深度分级与信息单元量 ④ 关联完整度（岗位/城市风险/城市调研/薪资）
 *          ⑤ 勾稽体检（复用 XWK_PROFILE 的 CHK-A~H）
 *
 * 只读，不改任何数据；页面与命令行工具共用同一份算法，口径唯一。
 * ================================================================== */
window.XWK_AUDIT = (function () {

  /* 主表必填字段：缺一项就少一项信贷可用的判断依据 */
  var REQ_FIELDS = [
    { k: '典型经营主体形态', w: 2, g: 'A 准入' },
    { k: '必备证照资质', w: 2, g: 'A 准入' },
    { k: '常见经营规模', w: 1, g: 'A 准入' },
    { k: '订单与客户来源', w: 2, g: 'A 准入' },
    { k: '典型融资用途', w: 1, g: 'A 准入' },
    { k: '前景趋势判断', w: 2, g: 'C 产业链' },
    { k: '毛利率区间', w: 2, g: 'B 单产' },
    { k: '净利率区间', w: 2, g: 'B 单产' },
    { k: '旺季月份', w: 1, g: 'B 单产' },
    { k: '淡季月份', w: 1, g: 'B 单产' },
    { k: '季节性资金缺口高峰', w: 1, g: 'D 失败与包装' },
    { k: '主要经营风险', w: 2, g: 'D 失败与包装' },
    { k: '政策与外部驱动', w: 1, g: 'C 产业链' },
    { k: '成本结构', w: 2, g: 'B 单产' }
  ];

  /* 档案九组：A 准入 / B 单产 / C 产业链 / D 失败与包装 / E 交叉验证 /
   *           F 额度与用途 / G 岗位核验 / H 城市差异 / I 数据体检 */
  var GROUPS = ['A_准入', 'B_单产模型', 'C_产业链', 'D_失败与包装', 'E_交叉验证',
    'F_额度与用途', 'G_岗位核验', 'H_城市差异', 'I_数据体检'];

  var EMPTY = ['', '-', '—', '无', '暂无', '待补', '待核实', 'n/a', 'N/A', 'null', 'undefined'];

  function isEmpty(v) {
    if (v == null) return true;
    var s = String(v).trim();
    if (!s) return true;
    if (EMPTY.indexOf(s) >= 0) return true;
    /* 纯标点占位 */
    return /^[、，,。.\s;；]+$/.test(s);
  }

  function flat(v) {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (Array.isArray(v)) return v.map(flat).filter(Boolean).join('；');
    if (typeof v === 'object') {
      if (v['值'] !== undefined) return flat(v['值']);
      return Object.keys(v).filter(function (k) { return ['depth_level', 'source', 'confidence', 'author', 'verified_at', '排序'].indexOf(k) < 0; })
        .map(function (k) { return flat(v[k]); }).filter(Boolean).join('；');
    }
    return String(v);
  }

  /* 档案里是否有来源：叶子节点的 source / 依据 字段（来源写在具体结论上，不在 meta 上） */
  function hasSource(d) {
    var hit = false;
    (function walk(o, depth) {
      if (hit || !o || typeof o !== 'object' || depth > 4) return;
      Object.keys(o).forEach(function (k) {
        if (hit) return;
        if ((k === 'source' || k === '来源' || k === '依据') && !isEmpty(o[k])) { hit = true; return; }
        walk(o[k], depth + 1);
      });
    })(d, 0);
    return hit;
  }

  /* ---------- 套话识别 ----------
   * 主表里的套话字段已被装配层清空（原值保留在 `字段_原始`），
   * 所以不能用现值做分布统计，必须用「原始值」回看当年套話的覆盖程度。
   * 判定：取值种类少（≤15）且最大共用值覆盖 ≥50% 行业。 */
  function fillerMap(inds) {
    var dist = {};    // 现值分布（判断当前是否仍在展示套话）
    var rawDist = {}; // 原值分布（判断当年套话覆盖程度）
    var blanked = {}; // 已按规范留白的行业数
    var total = inds.length || 1;

    REQ_FIELDS.forEach(function (f) {
      dist[f.k] = {}; rawDist[f.k] = {}; blanked[f.k] = 0;
      inds.forEach(function (i) {
        var raw = flat(i[f.k + '_原始']).trim();
        var cur = flat(i[f.k]).trim();
        if (!cur && raw) blanked[f.k]++;
        if (cur) dist[f.k][cur] = (dist[f.k][cur] || 0) + 1;
        if (raw) rawDist[f.k][raw] = (rawDist[f.k][raw] || 0) + 1;
      });
    });

    var top = function (d) {
      var vals = Object.keys(d), maxV = '', maxN = 0;
      vals.forEach(function (v) { if (d[v] > maxN) { maxN = d[v]; maxV = v; } });
      return { v: maxV, n: maxN, kinds: vals.length, vals: vals };
    };

    var out = {};
    REQ_FIELDS.forEach(function (f) {
      var rt = top(rawDist[f.k]);
      var ct = top(dist[f.k]);
      /* 当年套话：取值种类少且最大共用值覆盖 ≥50% */
      if (rt.kinds <= 15 && rt.n / total >= 0.5) {
        out[f.k] = {
          top: rt.v, n: rt.n, cover: rt.n / total, kinds: rt.kinds,
          blanked: blanked[f.k],
          /* 现值里仍在展示的套话（>5% 共用的取值） */
          hot: ct.vals.filter(function (v) { return dist[f.k][v] / total >= 0.05 && rawDist[f.k][v]; }),
          still: ct.n / total >= 0.5 && rawDist[f.k][ct.v] ? ct.n : 0
        };
      }
    });
    return { map: out, dist: dist, rawDist: rawDist, blanked: blanked };
  }

  /* ---------- 单个行业体检 ---------- */
  function auditOne(db, p, ctx) {
    var ind = p.base || {};
    var missing = [], filler = [], blanked = [], wTotal = 0, wGot = 0;

    REQ_FIELDS.forEach(function (f) {
      var v = flat(ind[f.k]).trim();
      var raw = flat(ind[f.k + '_原始']).trim();
      wTotal += f.w;
      /* 装配层已判定为套话并主动留白的字段：不算「待补」，单列为「已下线」 */
      if (isEmpty(v)) {
        if (raw) { blanked.push({ f: f.k, g: f.g, v: raw.slice(0, 40) }); wGot += f.w * 0.5; }
        else missing.push({ f: f.k, g: f.g });
        return;
      }
      var fm = ctx.filler.map[f.k];
      if (fm && fm.hot.indexOf(v) >= 0) { filler.push({ f: f.k, g: f.g, v: v.slice(0, 40) }); return; }
      wGot += f.w;
    });

    var fieldScore = wTotal ? Math.round(wGot / wTotal * 100) : 0;

    /* 三要素：来源落在档案叶子节点（source / 依据），非 meta 层 */
    var d = p.dossier || {};
    var meta = d.meta || {};
    var tri = {
      source: hasSource(d),
      confidence: !!(meta.confidence || meta['档案层级'] || p.confidence),
      verified_at: !!(meta.verified_at || p.verifiedAt)
    };
    var triScore = Math.round((tri.source ? 40 : 0) + (tri.confidence ? 30 : 0) + (tri.verified_at ? 30 : 0));

    /* 档案分组覆盖 */
    var gHit = GROUPS.filter(function (g) { return d[g] && Object.keys(d[g]).length > 0; });
    var groupScore = Math.round(gHit.length / GROUPS.length * 100);

    /* 关联完整度 */
    var jobN = p.jobs.length;
    var riskN = p.cityRisks.length;
    var cityN = (db.cities || []).length || 23;
    var resN = 0;
    var CR = db.cityResearch;
    var crInd = CR && (CR['行业调研'] || CR);
    if (crInd && crInd[p.code]) {
      resN = Object.keys(crInd[p.code]['城市调研'] || crInd[p.code]).length;
    }
    var salHit = 0;
    p.jobs.forEach(function (j) { if (p.salary && p.salary[j['常见职位']]) salHit++; });
    var assoc = {
      岗位数: jobN, 岗位合格: jobN >= 3,
      城市风险数: riskN, 城市风险合格: riskN >= cityN,
      城市调研数: resN, 城市调研合格: resN >= cityN,
      薪资覆盖: salHit, 薪资覆盖率: jobN ? Math.round(salHit / jobN * 100) : 0
    };
    var assocScore = Math.round(
      (assoc.岗位合格 ? 30 : (jobN ? 15 : 0)) +
      (assoc.城市风险合格 ? 25 : (riskN ? 12 : 0)) +
      (assoc.城市调研合格 ? 25 : (resN ? 12 : 0)) +
      (assoc.薪资覆盖率 >= 90 ? 20 : assoc.薪资覆盖率 >= 50 ? 12 : assoc.薪资覆盖率 > 0 ? 5 : 0)
    );

    /* 勾稽体检 */
    var chk = { 高: 0, 中: 0, 低: 0 };
    (p.checks || []).forEach(function (c) { if (chk[c['严重度']] !== undefined) chk[c['严重度']]++; });
    var chkScore = Math.max(0, 100 - chk['高'] * 30 - chk['中'] * 12 - chk['低'] * 4);

    var score = Math.round(fieldScore * 0.34 + triScore * 0.12 + groupScore * 0.09 + assocScore * 0.30 + chkScore * 0.15);
    var grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D';

    return {
      code: p.code, name: p.name, cat: p.cat, tier: p.tier, depth: p.depth,
      confidence: p.confidence, units: p.units,
      score: score, grade: grade,
      fieldScore: fieldScore, triScore: triScore, groupScore: groupScore,
      assocScore: assocScore, chkScore: chkScore,
      missing: missing, filler: filler, blanked: blanked, tri: tri, groups: gHit,
      groupTotal: GROUPS.length, assoc: assoc, chk: chk,
      checks: p.checks || [], hooks: (p.hooks || []).length
    };
  }

  /* ---------- 全库体检 ---------- */
  function auditAll(db) {
    var prof = db.profile || (window.XWK_PROFILE ? window.XWK_PROFILE.build(db) : null);
    if (!prof) return null;
    var inds = prof.list.filter(function (p) { return p.isIndustry; });
    var ctx = { filler: fillerMap(inds.map(function (p) { return p.base; })) };
    var rows = inds.map(function (p) { return auditOne(db, p, ctx); });

    rows.sort(function (a, b) { return a.score - b.score; });

    var avg = rows.length ? Math.round(rows.reduce(function (s, r) { return s + r.score; }, 0) / rows.length) : 0;
    var gradeDist = { A: 0, B: 0, C: 0, D: 0 };
    rows.forEach(function (r) { gradeDist[r.grade]++; });

    var missTop = {}, fillTop = {}, blankTop = {};
    rows.forEach(function (r) {
      r.missing.forEach(function (m) { missTop[m.f] = (missTop[m.f] || 0) + 1; });
      r.filler.forEach(function (f) { fillTop[f.f] = (fillTop[f.f] || 0) + 1; });
      r.blanked.forEach(function (f) { blankTop[f.f] = (blankTop[f.f] || 0) + 1; });
    });
    var toArr = function (o) {
      return Object.keys(o).map(function (k) { return { field: k, count: o[k] }; })
        .sort(function (a, b) { return b.count - a.count; });
    };

    var noCityRes = rows.filter(function (r) { return r.assoc['城市调研数'] === 0; }).length;
    var hasCityRes = rows.filter(function (r) { return r.assoc['城市调研合格']; }).length;
    var noJob = rows.filter(function (r) { return r.assoc['岗位数'] === 0; }).length;
    var highChk = rows.filter(function (r) { return r.chk['高'] > 0; });

    var depthDist = {};
    rows.forEach(function (r) { depthDist[r.depth] = (depthDist[r.depth] || 0) + 1; });

    return {
      total: rows.length,
      avg: avg,
      gradeDist: gradeDist,
      depthDist: depthDist,
      rows: rows,
      worst: rows.slice(0, 15),
      missingTop: toArr(missTop),
      fillerTop: toArr(fillTop),
      blankedTop: toArr(blankTop),
      fillerFields: ctx.filler.map,
      coverage: {
        有城市调研: hasCityRes,
        无城市调研: noCityRes,
        无岗位: noJob,
        高危勾稽行业: highChk.length
      },
      highChkTop: highChk.slice(0, 15)
    };
  }

  /* ---------- 报告 HTML（页面与命令行共用） ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function gradeColor(g) { return g === 'A' ? '#059669' : g === 'B' ? '#3b82f6' : g === 'C' ? '#d97706' : '#dc2626'; }

  function html(db, opts) {
    opts = opts || {};
    var a = auditAll(db);
    if (!a) return '<div class="ins">体检数据不可用</div>';
    var max = opts.limit || 20;
    var list = opts.worst ? a.worst : a.rows.slice(0, max);

    var h = '<div class="aud-wrap">';

    /* 总览 */
    h += '<div class="aud-ov">';
    h += '<div class="aud-c"><div class="aud-n">' + a.total + '</div><div class="aud-l">纳入体检行业</div></div>';
    h += '<div class="aud-c"><div class="aud-n" style="color:' + (a.avg >= 70 ? '#059669' : a.avg >= 55 ? '#d97706' : '#dc2626') + '">' + a.avg + '</div><div class="aud-l">平均体检分</div></div>';
    ['A', 'B', 'C', 'D'].forEach(function (g) {
      h += '<div class="aud-c"><div class="aud-n" style="color:' + gradeColor(g) + '">' + a.gradeDist[g] + '</div><div class="aud-l">' + g + ' 级</div></div>';
    });
    h += '</div>';

    /* 覆盖缺口 */
    h += '<div class="aud-grid">';
    h += '<div class="aud-box"><h5>城市调研覆盖</h5><p>已完成 <b>' + a.coverage['有城市调研'] + '</b> / ' + a.total +
      ' 个行业（23 城齐全）<br>未覆盖 <b style="color:#dc2626">' + a.coverage['无城市调研'] + '</b> 个</p></div>';
    h += '<div class="aud-box"><h5>岗位与勾稽</h5><p>无岗位记录 <b style="color:#dc2626">' + a.coverage['无岗位'] +
      '</b> 个<br>存在高危勾稽问题 <b style="color:#dc2626">' + a.coverage['高危勾稽行业'] + '</b> 个行业</p></div>';
    h += '</div>';

    /* 缺失字段 Top */
    if (a.missingTop.length) {
      h += '<div class="aud-box"><h5>缺失最多的字段（Top 8）</h5><div class="aud-bars">';
      var mx = a.missingTop[0].count || 1;
      a.missingTop.slice(0, 8).forEach(function (m) {
        h += '<div class="aud-row"><span class="aud-rl">' + esc(m.field) + '</span>' +
          '<div class="aud-rt"><div class="aud-rf" style="width:' + (m.count / mx * 100).toFixed(1) + '%;background:#dc2626"></div></div>' +
          '<span class="aud-rv">' + m.count + '</span></div>';
      });
      h += '</div></div>';
    }

    /* 套话字段 */
    var fk = Object.keys(a.fillerFields);
    if (fk.length) {
      h += '<div class="aud-box"><h5>套话字段（同一句被大量行业共用，已按规范留白，不作为决策依据）</h5><div class="aud-bars">';
      fk.forEach(function (k) {
        var f = a.fillerFields[k];
        h += '<div class="aud-row"><span class="aud-rl">' + esc(k) + '</span>' +
          '<div class="aud-rt"><div class="aud-rf" style="width:' + (f.cover * 100).toFixed(1) + '%;background:#94a3b8"></div></div>' +
          '<span class="aud-rv">' + (f.cover * 100).toFixed(0) + '%</span></div>';
        h += '<div class="aud-quote">当年共用原文：' + esc(f.top.slice(0, 60)) + '（' + f.n + ' 个行业，全库仅 ' + f.kinds +
          ' 种取值）→ 已留白 ' + (f.blanked || 0) + ' 个' +
          (f.still ? '；<b style="color:#dc2626">仍有 ' + f.still + ' 个行业在展示套话，待补</b>' : '；档案有真实内容的已回写') + '</div>';
      });
      h += '</div><p class="aud-tip">留白字段在行业详情/对比/导出中灰显斜体处理，评分模型不读取；' +
        '档案已核实内容的字段已由装配层回写真实值，原值保留为「字段_原始」备查。</p></div>';
    }

    /* 明细表 */
    h += '<div class="aud-box"><h5>' + (opts.worst ? '得分最低的 15 个行业（优先补数）' : '行业体检明细（前 ' + list.length + '）') + '</h5>' +
      '<div class="aud-tbl-wrap"><table class="aud-tbl"><thead><tr>' +
      '<th>编号</th><th>行业</th><th>体检分</th><th>字段</th><th>三要素</th><th>档案组</th><th>关联</th><th>勾稽</th>' +
      '<th>岗位</th><th>城市风险</th><th>城市调研</th><th>待补</th><th>已留白</th><th>高危</th>' +
      '</tr></thead><tbody>';
    list.forEach(function (r) {
      h += '<tr>' +
        '<td>' + esc(r.code) + '</td>' +
        '<td>' + esc(r.name) + '</td>' +
        '<td class="aud-g" style="color:' + gradeColor(r.grade) + ';font-weight:700">' + r.score + ' <small>' + r.grade + '</small></td>' +
        '<td>' + r.fieldScore + '</td>' +
        '<td>' + r.triScore + '</td>' +
        '<td>' + r.groups.length + '/' + r.groupTotal + '</td>' +
        '<td>' + r.assocScore + '</td>' +
        '<td>' + r.chkScore + '</td>' +
        '<td>' + r.assoc['岗位数'] + '</td>' +
        '<td>' + r.assoc['城市风险数'] + '</td>' +
        '<td>' + r.assoc['城市调研数'] + '</td>' +
        '<td>' + (r.missing.length ? '<span style="color:#dc2626">' + r.missing.length + '</span>' : '0') + '</td>' +
        '<td>' + (r.blanked.length ? '<span style="color:#94a3b8">' + r.blanked.length + '</span>' : '0') + '</td>' +
        '<td>' + (r.chk['高'] ? '<span style="color:#dc2626">' + r.chk['高'] + '</span>' : '0') + '</td>' +
        '</tr>';
    });
    h += '</tbody></table></div></div>';

    h += '<p class="aud-tip">口径：字段完整性 34% + 三要素 12% + 档案分组 9% + 关联完整度 30% + 勾稽体检 15%。' +
      'A≥85｜B≥70｜C≥55｜D&lt;55。19 个国防军工类（tier=NA）为非授信层，不纳入体检。</p>';

    h += '</div>';
    return h;
  }

  return {
    REQ_FIELDS: REQ_FIELDS, GROUPS: GROUPS,
    fillerMap: fillerMap, auditOne: auditOne, auditAll: auditAll,
    html: html, esc: esc, gradeColor: gradeColor
  };
})();
