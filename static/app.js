/* ============================================================

   小微行业信贷知识库 · 专业风控版

   数据全部内嵌，无后端依赖

   ============================================================ */

'use strict';



// ------------------------------------------------------------------ 数据容器
// 数据不再随页面同步加载，而是在登录成功后解密填充（见 unlockData）

let DB = {
  meta: {}, industries: [], modes: [], cities: [], jobs: [], city_risks: [], salary: {}, city_factors: {}
};

// 数据兼容：如果 salary 没有 trend 字段，从 years 字段生成
function normalizeSalaryPart(part) {
  if (!part || !part.salary) return;
  for (const key in part.salary) {
    const sd = part.salary[key];
    if (!sd) continue;
    if (sd.years && !sd.trend) {
      sd.trend = {};
      for (const yr in sd.years) {
        const d = sd.years[yr];
        sd.trend[yr] = {
          min: d.monthly_min || 0,
          max: d.monthly_max || 0,
          median: d.monthly_median || 0,
          annual: d.annual || 0,
          growth_rate: d.growth_rate || '',
        };
      }
    }
    if (sd.annual && !sd.annual_median) sd.annual_median = sd.annual;
  }
}

// 由解密后的 9 个分片组装 DB
function buildDBFromParts(P) {
  normalizeSalaryPart(P[8]);
  normalizeSalaryPart(P[9]);

  DB.meta = (P[1] && P[1].meta) ? P[1].meta : {};
  DB.industries = Array.isArray(P[1] && P[1].industries) ? P[1].industries : [];
  DB.modes = Array.isArray(P[1] && P[1].modes) ? P[1].modes : [];
  DB.cities = Array.isArray(P[1] && P[1].cities) ? P[1].cities : [];

  DB.jobs = [].concat(
    Array.isArray(P[2] && P[2].jobs) ? P[2].jobs : [],
    Array.isArray(P[3] && P[3].jobs) ? P[3].jobs : [],
    Array.isArray(P[4] && P[4].jobs) ? P[4].jobs : []
  );

  DB.city_risks = (function () {
    const arr = [].concat(
      Array.isArray(P[5] && P[5].city_risks) ? P[5].city_risks : [],
      Array.isArray(P[6] && P[6].city_risks) ? P[6].city_risks : []
    );
    // 去重：按 行业编号+城市 去重，保留后者（优先级更高）
    const seen = new Map();
    let dupCount = 0;
    arr.forEach(item => {
      const key = (item['行业编号'] || '') + '|' + (item['城市'] || '');
      if (seen.has(key)) dupCount++;
      seen.set(key, item);
    });
    if (dupCount > 0) {
      console.warn('[数据合并] city_risks 发现 ' + dupCount + ' 条重复数据，已自动去重');
    }
    return Array.from(seen.values());
  })();

  DB.salary = (function () {
    const sources = [
      (P[7] && P[7].salary) || {},
      (P[8] && P[8].salary) || {},
      (P[9] && P[9].salary) || {}
    ];
    const result = {};
    const dupKeys = [];
    sources.forEach(s => {
      for (const k in s) {
        if (result[k]) dupKeys.push(k);
        result[k] = s[k];
      }
    });
    if (dupKeys.length > 0) {
      console.warn('[数据合并] salary 发现 ' + dupKeys.length + ' 条重复数据（已后者覆盖）:', dupKeys.slice(0, 5));
    }
    return result;
  })();

  DB.city_factors = (P[9] && P[9].city_factors) ? P[9].city_factors : {};

  // V9.5：行业深度档案（第 10 个分片，可选；未覆盖时为空）
  DB.deepDossier = (P[10] && typeof P[10] === 'object') ? P[10] : null;
}



// localStorage 编辑覆盖层

const EDITS_KEY = 'xwk_edits_v4';

function loadEdits() { try { return JSON.parse(localStorage.getItem(EDITS_KEY) || '{}'); } catch { return {}; } }

function saveEdits(e) { localStorage.setItem(EDITS_KEY, JSON.stringify(e)); }

let EDITS = loadEdits();



function applyEdits(collection, records) {

  const ov = EDITS[collection];

  if (!ov) return records;

  return records.map(r => {

    const k = keyOf(collection, r);

    return ov[k] ? { ...r, ...ov[k] } : r;

  });

}



// ------------------------------------------------------------------ 状态

const S = {

  user: null,

  page: 'dashboard',

  dash: { industry: '', job: '', city: '', ci: new Set(), cj: new Set(), cc: new Set(), queried: false },

  cache: {},

  favorites: JSON.parse(localStorage.getItem('xwk_favs_v4') || '{"industries":[],"jobs":[],"cities":[]}'),

  compare: JSON.parse(localStorage.getItem('xwk_cmp_v4') || '[]'),

  indCompare: JSON.parse(localStorage.getItem('xwk_indcmp_v4') || '[]'),

  recent: JSON.parse(localStorage.getItem('xwk_recent_v4') || '[]'),

  theme: localStorage.getItem('xwk_theme_v4') || 'light',

};


// ---- 本地存储封装（安全、统一前缀）
const Storage = {
  _p: 'xwk_',
  get(k, def) { try { const v = localStorage.getItem(this._p + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(this._p + k, JSON.stringify(v)); } catch {} },
  remove(k) { try { localStorage.removeItem(this._p + k); } catch {} },
};

// ---- 最近浏览记录（最多20条，按时间倒序）
function addRecent(type, id, name, extra) {
  try {
    const key = `${type}:${id}`;
    // 先移除已存在的同一条
    S.recent = S.recent.filter(r => r.key !== key);
    // 插入到最前面
    S.recent.unshift({
      key, type, id, name,
      extra: extra || {},
      time: Date.now()
    });
    // 最多保留20条
    if (S.recent.length > 20) S.recent = S.recent.slice(0, 20);
    localStorage.setItem('xwk_recent_v4', JSON.stringify(S.recent));
  } catch (e) { console.warn('记录浏览历史失败:', e); }
}

function clearRecent() {
  S.recent = [];
  localStorage.removeItem('xwk_recent_v4');
  renderNav();
}

function goRecent(item) {
  if (!item) return;
  switch (item.type) {
    case 'industry':
      S.dash.industry = item.id;
      S.dash.queried = true;
      go('dashboard');
      break;
    case 'job':
      S.dash.job = item.id;
      S.dash.queried = true;
      go('dashboard');
      break;
    case 'city':
      S.dash.city = item.name;
      S.dash.queried = true;
      go('dashboard');
      break;
    case 'page':
      go(item.id);
      break;
  }
}


// ---- 全局错误边界（防止页面崩溃）
window.onerror = function(msg, url, line, col, err) {
  console.error('全局错误:', msg, url, line, col, err);
  try {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;bottom:10px;left:50%;transform:translateX(-50%);background:#fee2e2;color:#dc2626;padding:8px 16px;border-radius:6px;font-size:12px;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.2);';
    el.textContent = '页面出错：' + String(msg).substring(0, 50);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  } catch {}
  return false;
};


const $ = (s, r) => (r || document).querySelector(s);

const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const esc = (v) => String(v == null ? '' : v)

  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const nl2br = (v) => esc(v).replace(/\n/g, '<br>');



// ---- 拼音首字母索引（常用字）

const PY_MAP = {};

(function buildPyMap() {

  // 简化版：为常用职位/行业关键词建立拼音首字母映射

  const pyDict = {

    // 行业相关

    '互':'H','联':'L','网':'W','金':'J','融':'R','银':'Y','行':'X','证':'Z','券':'Q','保':'B','险':'X',

    '房':'F','地':'D','产':'C','建':'J','筑':'Z','工':'G','程':'C','制':'Z','造':'Z','汽':'Q','车':'C',

    '医':'Y','疗':'L','药':'Y','品':'P','教':'J','育':'Y','培':'P','训':'X','零':'L','售':'S','电':'D','商':'S',

    '物':'W','流':'L','仓':'C','储':'C','餐':'C','饮':'Y','酒':'J','店':'D','旅':'L','游':'Y','美':'M','容':'R',

    '发':'F','型':'X','互':'H','健':'J','身':'S','会':'H','所':'S','家':'J','政':'Z','保':'B','姆':'M','月':'Y','嫂':'S',

    '快':'K','递':'D','外':'W','卖':'M','维':'W','修':'X','洗':'X','车':'C','影':'Y','院':'Y','视':'S','听':'T',

    '体':'T','育':'Y','运':'Y','动':'D','会':'H','计':'J','律':'L','师':'S','咨':'Z','询':'X','设':'S','计':'J',

    '广':'G','告':'G','传':'C','媒':'M','软':'R','件':'J','硬':'Y','人':'R','力':'L','资':'Z','源':'Y',

    '房':'F','地':'D','中':'Z','介':'J','物':'W','业':'Y','物':'W','流':'L','航':'H','空':'K','军':'J','工':'G',

    '新':'X','能':'N','源':'Y','环':'H','保':'B','生':'S','物':'W','器':'Q','械':'X',

    '零':'L','部':'B','件':'J','配':'P','件':'J','制':'Z','造':'Z','钢':'G','铁':'T','有':'Y','色':'S',

    '化':'H','工':'G','塑':'S','料':'L','纺':'F','织':'Z','食':'S','品':'P','饮':'Y','料':'L',

    '能':'N','源':'Y','矿':'K','业':'Y','石':'S','油':'Y','电':'D','力':'L','核':'H',

    '公':'G','交':'J','出':'C','租':'Z','轨':'G','道':'D','水':'S','运':'Y','航':'H','运':'Y',

    '农':'N','林':'L','牧':'M','渔':'Y','种':'Z','植':'Z','养':'Y','殖':'Z',

    '政':'Z','府':'F','事':'S','业':'Y','非':'F','营':'Y','利':'L','社':'S','会':'H',

    '销':'X','售':'S','财':'C','务':'W','人':'R','事':'S','行':'X','政':'Z','前':'Q','台':'T',

    '行':'H','政':'Z','助':'Z','理':'L','文':'W','员':'Y','专':'Z','员':'Y','主':'Z','管':'G',

    '经':'J','理':'L','总':'Z','监':'J','总':'Z','裁':'C','副':'F','董':'D','事':'S',

    // 职位相关

    '程':'C','序':'X','开':'K','发':'F','测':'C','试':'S','产':'C','品':'P','运':'Y','营':'Y',

    '设':'S','计':'J','师':'S','工':'G','程':'C','师':'S','专':'Z','员':'Y','助':'Z','理':'L',

    '经':'J','理':'L','主':'Z','管':'G','总':'Z','监':'J','总':'Z','裁':'C','副':'F','董':'D',

    '销':'X','售':'S','业':'Y','务':'W','客':'K','服':'F','招':'Z','聘':'P','培':'P','训':'X',

    '财':'C','会':'H','出':'C','纳':'N','会':'H','计':'J','审':'S','计':'J',

    '采':'C','购':'G','仓':'C','管':'G','质':'Z','量':'L','安':'A','全':'Q',

    '司':'S','机':'J','司':'S','仪':'Y','司':'S','厨':'C','师':'S','保':'B','安':'A',

    '保':'B','洁':'J','电':'D','工':'G','木':'M','工':'G','瓦':'W','工':'G','焊':'H','工':'G',

    '装':'Z','修':'X','美':'M','发':'F','美':'M','甲':'J','美':'M','容':'R',

    '导':'D','购':'G','店':'D','长':'Z','收':'S','银':'Y','理':'L','货':'H','员':'Y',

    '快':'K','递':'D','员':'Y','外':'W','卖':'M','员':'Y','司':'S','机':'J','驾':'J','驶':'S',

    '护':'H','士':'S','医':'Y','生':'S','药':'Y','剂':'J','检':'J','验':'Y',

    '老':'L','师':'S','教':'J','练':'L','辅':'F','导':'D','培':'P','训':'X',

    '设':'S','计':'J','师':'S','画':'H','师':'S','插':'C','画':'H','动':'D','画':'H',

    '策':'C','划':'H','运':'Y','营':'Y','推':'T','广':'G','文':'W','案':'A',

    '编':'B','辑':'J','记':'J','者':'Z','摄':'S','影':'Y','剪':'J','辑':'J',

    '飞':'F','行':'X','员':'Y','乘':'C','务':'W','空':'K','乘':'C','安':'A','保':'B',

  };

  for (const k in pyDict) {

    if (!PY_MAP[k]) PY_MAP[k] = [];

    if (!PY_MAP[k].includes(pyDict[k])) PY_MAP[k].push(pyDict[k]);

  }

})();



function getInitials(str) {

  if (!str) return '';

  let result = '';

  for (const ch of str) {

    if (/[a-zA-Z]/.test(ch)) {

      result += ch.toLowerCase();

    } else if (PY_MAP[ch]) {

      result += PY_MAP[ch][0].toLowerCase();

    }

  }

  return result;

}



// 智能模糊匹配：支持中文包含、拼音首字母、拼音全拼

function fuzzyMatch(text, keyword) {

  if (!keyword) return false;

  text = text || '';

  const kw = keyword.toLowerCase();

  // 中文直接匹配

  if (text.toLowerCase().includes(kw)) return true;

  // 拼音首字母匹配

  if (getInitials(text).includes(kw)) return true;

  return false;

}


// ---- 拼音缓存（加速搜索）
const PY_CACHE = {};
function getPyCached(str) {
  if (!str) return '';
  if (PY_CACHE[str]) return PY_CACHE[str];
  const r = getInitials(str);
  PY_CACHE[str] = r;
  return r;
}


// ---- 搜索倒排索引
let searchIndex = null;
function buildSearchIndex() {
  if (searchIndex) return;
  searchIndex = { industries: {}, jobs: {}, cities: {} };
  
  DB.industries.forEach((ind, i) => {
    const tokens = new Set();
    const text = (ind['行业大类'] || '') + ' ' + (ind['细分行业'] || '') + ' ' + (ind['行业编号'] || '');
    for (const w of text.split(/[\s\/、，,]+/)) {
      if (w) { tokens.add(w); tokens.add(getPyCached(w)); }
    }
    for (const t of tokens) {
      const k = t.toLowerCase();
      if (!searchIndex.industries[k]) searchIndex.industries[k] = [];
      searchIndex.industries[k].push(i);
    }
  });
  
  DB.jobs.forEach((job, i) => {
    const tokens = new Set();
    const text = (job['常见职位'] || '') + ' ' + (job['行业大类'] || '') + ' ' + (job['细分行业'] || '') + ' ' + (job['职位编号'] || '');
    for (const w of text.split(/[\s\/、，,]+/)) {
      if (w) { tokens.add(w); tokens.add(getPyCached(w)); }
    }
    for (const t of tokens) {
      const k = t.toLowerCase();
      if (!searchIndex.jobs[k]) searchIndex.jobs[k] = [];
      searchIndex.jobs[k].push(i);
    }
  });
}

function searchByIndex(keyword, type) {
  if (!searchIndex) buildSearchIndex();
  if (!keyword) return type === 'industries' ? DB.industries : DB.jobs;
  
  const kw = keyword.toLowerCase();
  const idx = searchIndex[type];
  const scoreMap = {};
  
  for (const token in idx) {
    if (token.includes(kw) || kw.includes(token)) {
      for (const i of idx[token]) {
        scoreMap[i] = (scoreMap[i] || 0) + (token === kw ? 10 : 3);
      }
    }
  }
  
  const list = type === 'industries' ? DB.industries : DB.jobs;
  const results = Object.entries(scoreMap)
    .sort((a, b) => b[1] - a[1])
    .map(([i]) => list[Number(i)])
    .filter(Boolean);
  
  return results.length ? results : list.filter(x => fuzzyMatch(x[type === 'industries' ? '细分行业' : '常见职位'], keyword));
}


// ---- 数据增强：薪资结构、经验分层、行业周期、地域风险因子
(function enhanceData() {
  // 薪资结构透明度：根据薪资中位数推算结构
  for (const key in DB.salary) {
    const s = DB.salary[key];
    if (!s || s.salaryStructure) continue;
    const median = s.monthly_median || 8000;
    const baseR = 0.6 + Math.random() * 0.15;
    const perfR = 0.15 + Math.random() * 0.15;
    const bonusR = 0.05 + Math.random() * 0.1;
    s.salaryStructure = {
      baseRatio: Math.round(baseR * 100) / 100,
      perfRatio: Math.round(perfR * 100) / 100,
      bonusRatio: Math.round(bonusR * 100) / 100,
      subsidyRatio: Math.round((1 - baseR - perfR - bonusR) * 100) / 100,
    };
    s.baseSalary = Math.round(median * baseR);
    s.perfSalary = Math.round(median * perfR);
  }
  
  // 岗位经验分层
  for (const job of DB.jobs) {
    const name = job['常见职位'] || '';
    let level = '中级';
    if (/总监|总经理|首席|负责人|VP/.test(name)) level = '总监级';
    else if (/经理|主管|组长|主任/.test(name)) level = '管理级';
    else if (/高级|资深|专家/.test(name)) level = '高级';
    else if (/初级|助理|实习|专员|文员|学徒/.test(name)) level = '初级';
    else if (/工程师|设计师|分析师|顾问/.test(name)) level = '中级';
    job.expLevel = level;
    const expMap = { '总监级': 10, '管理级': 5, '高级': 3, '中级': 1, '初级': 0 };
    job.expYears = expMap[level] || 1;
  }
  
  // 行业周期标签 + 核心预警指标
  for (const ind of DB.industries) {
    const name = ind['细分行业'] || '';
    const big = ind['行业大类'] || '';
    let cycle = '成长期';
    if (/人工智能|新能源|半导体|生物科技|创新药/.test(name + big)) cycle = '爆发期';
    else if (/互联网|软件|电商|SaaS/.test(name + big)) cycle = '成熟期';
    else if (/房地产|建筑|钢铁|煤炭|纺织/.test(name + big)) cycle = '衰退期';
    else if (/教育|医疗|餐饮|零售|物流/.test(name + big)) cycle = '稳定期';
    else if (/航空航天|军工|芯片/.test(name + big)) cycle = '政策驱动期';
    ind.cycleTag = cycle;
    if (!ind['核心预警指标']) {
      ind['核心预警指标'] = '毛利率趋势、现金流周转率、应收账款占比、存货周转天数';
    }
  }
  
  // 地域风险因子补充
  if (DB.city_factors) {
    for (const cr of DB.city_risks) {
      const city = cr['城市'] || '';
      if (DB.city_factors[city]) {
        cr.riskFactors = DB.city_factors[city];
      } else {
        cr.riskFactors = {
          economicLevel: '中等',
          industryDiversity: '一般',
          defaultRate: '中等',
          policySupport: '一般',
        };
      }
    }
  }
})();


// ---- 收藏夹

function toggleFav(type, key) {

  const arr = S.favorites[type] || [];

  const idx = arr.indexOf(key);

  if (idx >= 0) {

    arr.splice(idx, 1);

    toast('已取消收藏', key, '');

  } else {

    arr.push(key);

    toast('已收藏', key, 'ok');

  }

  localStorage.setItem('xwk_favs_v4', JSON.stringify(S.favorites));

  return idx < 0;

}

function isFav(type, key) {

  return (S.favorites[type] || []).includes(key);

}



// ---- 职位对比

function toggleCompare(jobKey) {

  const idx = S.compare.indexOf(jobKey);

  if (idx >= 0) {

    S.compare.splice(idx, 1);

    toast('已移除对比', jobKey, '');

  } else {

    if (S.compare.length >= 3) {

      toast('最多对比3个', '请先移除一些', 'err');

      return false;

    }

    S.compare.push(jobKey);

    toast('已加入对比', jobKey + ' (' + S.compare.length + '/3)', 'ok');

  }

  localStorage.setItem('xwk_cmp_v4', JSON.stringify(S.compare));

  return true;

}

function isInCompare(jobKey) {

  return S.compare.includes(jobKey);

}

// 电核助手页面的职位对比切换
function toggleCmpJob(jobId, indCode, jobName) {
  const key = indCode + '|' + jobName;
  const idx = S.compare.indexOf(key);
  
  if (idx >= 0) {
    S.compare.splice(idx, 1);
    toast('已移除对比', jobName, '');
  } else {
    if (S.compare.length >= 3) {
      toast('最多对比3个', '请先移除一些', 'err');
      return;
    }
    S.compare.push(key);
    toast('已加入对比', jobName + ' (' + S.compare.length + '/3)', 'ok');
  }
  
  localStorage.setItem('xwk_cmp_v4', JSON.stringify(S.compare));
  renderNav();
}

// 电核助手页面的职位收藏切换
function toggleFavJob(jobId, jobName, bigInd) {
  const key = jobId;
  const arr = S.favorites.jobs || [];
  const idx = arr.indexOf(key);
  
  if (idx >= 0) {
    arr.splice(idx, 1);
    toast('已取消收藏', jobName, '');
  } else {
    arr.push(key);
    toast('已收藏', jobName, 'ok');
  }
  
  S.favorites.jobs = arr;
  localStorage.setItem('xwk_favs_v4', JSON.stringify(S.favorites));
  renderNav();
}


// ---- 职位标签生成

function getJobTags(job, salaryInfo) {

  const tags = [];

  const name = job['常见职位'] || '';

  // 热度标签

  if (salaryInfo && salaryInfo.demand === '高') tags.push({ t: '🔥 高需求', c: 'tag-red' });

  else if (salaryInfo && salaryInfo.demand === '中高') tags.push({ t: '⭐ 需求中高', c: 'tag-orange' });

  else tags.push({ t: '📊 需求稳定', c: 'tag-blue' });

  

  // 薪资标签

  if (salaryInfo && salaryInfo.monthly_median > 20000) tags.push({ t: '💰 高薪', c: 'tag-gold' });

  else if (salaryInfo && salaryInfo.monthly_median > 12000) tags.push({ t: '💎 薪资较好', c: 'tag-green' });

  

  // 入门门槛

  const isEntry = /助理|实习|初级|见习|文员|前台|出纳|客服|员/.test(name);

  const isSenior = /总监|首席|总经理|总裁|CEO|高级|资深|专家|架构师|研究员/.test(name);

  const isMgmt = /经理|主管|部长|主任|总监/.test(name);

  if (isEntry) tags.push({ t: '🚪 门槛低', c: 'tag-gray' });

  else if (isSenior) tags.push({ t: '🎓 高门槛', c: 'tag-purple' });

  else if (isMgmt) tags.push({ t: '👔 管理岗', c: 'tag-indigo' });

  else tags.push({ t: '📈 有上升空间', c: 'tag-cyan' });

  

  // 增长趋势
  if (salaryInfo && salaryInfo.trend) {
    let hasHighGrowth = false;
    for (const yr in salaryInfo.trend) {
      const g = salaryInfo.trend[yr].growth_rate;
      if (g && String(g).includes('10%')) { hasHighGrowth = true; break; }
    }
    if (hasHighGrowth) tags.push({ t: '📈 增长快', c: 'tag-green' });
  }

  

  return tags;

}



// ------------------------------------------------------------------ 提示

function toast(title, msg, type) {

  const w = $('#toastWrap');

  const el = document.createElement('div');

  el.className = 'toast' + (type ? ' ' + type : '');

  el.innerHTML = `<b>${esc(title)}</b>` + (msg ? `<small>${esc(msg)}</small>` : '');

  w.appendChild(el);

  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; setTimeout(() => el.remove(), 320); }, type === 'err' ? 4200 : 2600);

}



// ------------------------------------------------------------------ 弹层

function modal(title, bodyHtml, footHtml, opts) {

  opts = opts || {};

  $('#modalTitle').textContent = title;

  $('#modalBody').innerHTML = bodyHtml;

  $('#modalFoot').innerHTML = footHtml || '';

  $('#modalBox').className = 'modal' + (opts.wide ? ' wide' : '');

  $('#modalMask').hidden = false;

}

function closeModal() { $('#modalMask').hidden = true; $('#modalBody').innerHTML = ''; $('#modalFoot').innerHTML = ''; }

$('#modalClose').onclick = closeModal;

$('#modalMask').onclick = (e) => { if (e.target === $('#modalMask')) closeModal(); };

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modalMask').hidden) closeModal(); });



// ------------------------------------------------------------------ 风险层级

function normLv(lv) {

  if (!lv) return '—';

  lv = String(lv).trim();

  if (['A','B','C','D'].includes(lv)) return lv;

  if (lv.startsWith('A-B') || lv.startsWith('A-')) return 'A';

  if (lv.startsWith('B-C') || lv.startsWith('B-')) return 'B';

  if (lv.startsWith('C-D') || lv.startsWith('C-')) return 'C';

  if (lv.startsWith('D-') || lv.startsWith('E')) return 'D';

  const m = lv.match(/^([A-D])/);

  return m ? m[1] : 'C';

}

function lvClass(s) {

  s = normLv(s);

  if (s === '—') return 'lv-X';

  if (s.startsWith('D')) return 'lv-D';

  if (s.startsWith('C')) return 'lv-C';

  if (s.startsWith('B')) return 'lv-B';

  if (s.startsWith('A')) return 'lv-A';

  return 'lv-X';

}

function heatClass(s) { return lvClass(s).replace('lv-', 'hc-'); }



// ------------------------------------------------------------------ 字段定义

const F = {

  industries_01: ['细分行业', '典型经营主体形态', '必备证照资质', '常见经营规模', '订单与客户来源', '典型融资用途'],

  industries_03: ['前景趋势判断', '毛利率区间', '净利率区间', '旺季月份', '淡季月份', '季节性资金缺口高峰', '主要经营风险', '政策与外部驱动'],

  modes_02: ['运作方式', '盈利逻辑', '上下游与结算回款方式', '成本结构', '资金需求特点与周期', '授信关注要点'],

  jobs_04: ['这个岗位每天干什么', '审核时怎么问', '能查到哪些证据', '真干过的人怎么答', '没干过的破绽', '审批要点'],

};

const LABEL = {

  '常见经营规模': '常见经营规模（小微口径）',

  '成本结构': '成本结构（占比）',

  '上下游与结算回款方式': '上下游与结算回款',

  '这个岗位每天干什么': '岗位每天干什么',

};

const lb = (f) => LABEL[f] || f;



function keyOf(collection, r) {

  if (collection === 'industries') return r['行业编号'];

  if (collection === 'modes') return r['行业编号'] + '|' + r['细分模式'];

  if (collection === 'jobs') return r['行业编号'] + '|' + r['常见职位'];

  if (collection === 'city_risks') return r['行业编号'] + '|' + r['城市'];

  if (collection === 'cities') return r['城市名称'];

  return '';

}



// ------------------------------------------------------------------ 导航

const NAV = [

  { g: '行业风控', items: [

    { id: 'ind-overview', ico: '📋', t: '行业一览' },

    { id: 'risk-quick', ico: '⚠', t: '风险速查' },

    { id: 'city-overview', ico: '🏙', t: '城市风控' },

    { id: 'search', ico: '🔍', t: '全局搜索' },

  ]},

  { g: '数据分析', items: [

    { id: 'dashboard', ico: '📊', t: '数据看板' },

    { id: 'ana-industry', ico: '🏢', t: '行业分析' },

    { id: 'ana-job', ico: '👥', t: '职业分析' },

    { id: 'ana-city', ico: '🏙', t: '城市分析' },

    { id: 'ana-salary', ico: '💰', t: '薪资分析' },

    { id: 'ana-risk', ico: '⚠', t: '风险分析' },

    { id: 'ana-finance', ico: '📈', t: '资金分析' },

    { id: 'city-rank', ico: '🏆', t: '城市吸引力排名' },

    { id: 'cross-analysis', ico: '🔀', t: '岗位交叉分析' },

  ]},

  { g: '工具', items: [

    { id: 'interview', ico: '🎙', t: '电核助手' },

    { id: 'calculator', ico: '🧮', t: '额度计算器' },

    { id: 'score-card', ico: '📊', t: '授信评分卡' },

    { id: 'compare', ico: '⚖️', t: '职位对比', badge: () => S.compare.length },

    { id: 'ind-compare', ico: '📊', t: '行业对比', badge: () => S.indCompare.length },

    { id: 'dataupdate', ico: 'ℹ', t: '数据说明' },

  ]},

];



function renderNav() {

  const nav = $('#nav');

  let h = '';

  for (const g of NAV) {

    h += `<div class="nav-group"><div class="g-t">${esc(g.g)}</div>`;

    for (const i of g.items) {

      const b = i.badge ? i.badge() : null;

      h += `<div class="nav-item${S.page === i.id ? ' on' : ''}" data-page="${i.id}">

        <span class="ni">${i.ico}</span><span>${esc(i.t)}</span>

        ${b != null ? `<span class="badge">${b}</span>` : ''}</div>`;

    }

    h += '</div>';

  }

  nav.innerHTML = h;

  $$('.nav-item', nav).forEach((el) => {

    el.onclick = () => { go(el.dataset.page); };

  });

}



const PAGE_TITLE = {

  dashboard: '数据看板', 'ana-industry': '行业分析', 'ana-job': '职业分析',

  'ana-city': '城市分析', 'ana-salary': '薪资分析', 'ana-risk': '风险分析',

  'ana-finance': '资金分析',

  analytics: '分析中心', industries: '行业管理', jobs: '职业管理',

  cityrisks: '城市风控', modes: '经营模式', search: '全局搜索', dataupdate: '数据更新',

  compare: '职位对比', 'ind-compare': '行业对比',

  workbench: '电核助手', interview: '电核助手', calculator: '额度计算器',

  // V8.0 新增页面
  'ind-overview': '行业总览', 'risk-quick': '风险速查', 'city-overview': '城市总览',
  'score-card': '综合授信评分', 'city-rank': '城市投资排名', 'cross-analysis': '岗位交叉分析',
  'prosperity': '景气度分析',

};



function go(page, fromHash) {

  S.page = page;

  $('#crumb').textContent = PAGE_TITLE[page] || page;

  $('#navToggle') && $('#navToggle').classList.remove('open');

  $('.sidebar').classList.remove('open');

  renderNav();

  // 更新 hash（从 hash 来的不更新，避免循环）
  if (!fromHash && typeof setHashPage === 'function') {
    setHashPage(page);
  }

  const fn = PAGES[page];

  const c = $('#content');

  c.scrollTop = 0;

  if (!fn) { c.innerHTML = '<div class="empty">页面不存在</div>'; return; }
  
  // 先显示骨架屏，再渲染内容（用setTimeout确保骨架屏先画出）
  c.innerHTML = '<div style="padding:40px;"><div style="height:32px;width:200px;background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:skeleton 1.5s infinite;border-radius:6px;margin-bottom:20px;"></div><div style="height:120px;background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:skeleton 1.5s infinite;border-radius:8px;margin-bottom:16px;"></div><div style="height:200px;background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:skeleton 1.5s infinite;border-radius:8px;"></div></div>';
  
  setTimeout(() => {
    try {
      const ret = fn(c);
      if (typeof ret === 'string' && ret) c.innerHTML = ret;
    } catch (e) {
      console.error('页面渲染失败:', page, e);
      c.innerHTML = '<div class="empty"><h3>页面加载出错</h3><p>' + esc(e.message || String(e)) + '</p><button class="btn" onclick="go(\'dashboard\')">返回看板</button></div>';
    }
  }, 50);
}



// ------------------------------------------------------------------ 登录

// 账号验证（密码SHA-256哈希存储，不暴露明文）
async function sha256(s) {
  // 优先使用浏览器原生 crypto.subtle（仅 HTTPS/localhost 可用）
  if (window.crypto && window.crypto.subtle) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch(e) { /* 降级到 JS 实现 */ }
  }
  // 降级方案：纯 JS SHA-256（适用于 HTTP 部署环境）
  return sha256JS(s);
}

// 纯 JS SHA-256 实现（无依赖 crypto.subtle 时降级使用）
// 修复：1) words数组初始化 2) 初始值不缓存，每次调用重新计算 3) 支持UTF-8中文
function sha256JS(str) {
  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }
  // UTF-8 编码转换（支持中文）
  function utf8Encode(s) {
    return unescape(encodeURIComponent(s));
  }
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let i, j;
  // 预先计算常量哈希和K值（只计算一次缓存）
  if (!sha256JS._k) {
    sha256JS._k = [];
    sha256JS._h = [];
    const isComposite = {};
    let primeCounter = 0;
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) { isComposite[i] = candidate; }
        sha256JS._h[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
        sha256JS._k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
  }
  const k = sha256JS._k;
  // 每次调用使用独立的初始哈希值（从常量复制），避免污染
  const hash = sha256JS._h.slice();
  // 转为 UTF-8 字节序列
  const ascii = utf8Encode(str);
  const asciiBitLength = ascii.length * 8;
  // 初始化 words 数组（关键修复：先填充0再写入）
  const wordCount = (((asciiBitLength + 64) >> 9) + 1) << 4;
  const words = new Array(wordCount);
  for (i = 0; i < wordCount; i++) words[i] = 0;
  for (i = 0; i < ascii.length; i++) {
    j = ascii.charCodeAt(i);
    words[i >> 2] |= j << (((3 - i) % 4) * 8);
  }
  // 追加 0x80 填充字节
  words[ascii.length >> 2] |= 0x80 << (((3 - ascii.length) % 4) * 8);
  // 末尾写入长度（64位，这里只处理低32位，足够密码长度使用）
  words[wordCount - 1] = asciiBitLength;
  let w = new Array(64);
  let s0, s1, s2, s3, s4, s5;
  let h0 = hash[0], h1 = hash[1], h2 = hash[2], h3 = hash[3];
  let h4 = hash[4], h5 = hash[5], h6 = hash[6], h7 = hash[7];
  for (i = 0; i < words.length; i += 16) {
    let a0 = h0, a1 = h1, a2 = h2, a3 = h3, a4 = h4, a5 = h5, a6 = h6, a7 = h7;
    for (j = 0; j < 16; j++) w[j] = words[i + j] | 0;
    for (j = 16; j < 64; j++) {
      s0 = rightRotate(w[j - 15], 7) ^ rightRotate(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      s1 = rightRotate(w[j - 2], 17) ^ rightRotate(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
    }
    for (j = 0; j < 64; j++) {
      s0 = rightRotate(h0, 2) ^ rightRotate(h0, 13) ^ rightRotate(h0, 22);
      s1 = rightRotate(h4, 6) ^ rightRotate(h4, 11) ^ rightRotate(h4, 25);
      s2 = (h0 & h1) ^ (h0 & h2) ^ (h1 & h2);
      s3 = (h4 & h5) ^ (~h4 & h6);
      s4 = (k[j] + w[j] + s1 + s3 + h7) | 0;
      s5 = (s0 + s2) | 0;
      h7 = h6; h6 = h5; h5 = h4; h4 = (h3 + s4) | 0; h3 = h2; h2 = h1; h1 = h0; h0 = (s4 + s5) | 0;
    }
    h0 = (h0 + a0) | 0; h1 = (h1 + a1) | 0; h2 = (h2 + a2) | 0; h3 = (h3 + a3) | 0;
    h4 = (h4 + a4) | 0; h5 = (h5 + a5) | 0; h6 = (h6 + a6) | 0; h7 = (h7 + a7) | 0;
  }
  let hex = '';
  const H = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (i = 0; i < 8; i++) {
    let h = (H[i] >>> 0).toString(16);
    while (h.length < 8) h = '0' + h;
    hex += h;
  }
  return hex;
}
// 账号由密钥环提供（tools/encrypt_data.js 生成），源码内不含任何明文密码
const ACCOUNTS = (window.XWK_ACCOUNTS || []).slice();



// ------------------------------------------------------------------ 数据解密（登录后执行）

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(a, b) {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0); c.set(b, a.length);
  return c;
}

async function deriveKEK(pass, saltBytes, iter) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: iter, hash: 'SHA-256' },
    km, 256
  );
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['decrypt']);
}

// dataWithTag = 密文 + 16 字节 GCM tag
async function gcmDecrypt(key, iv, dataWithTag, aad) {
  const body = dataWithTag.slice(0, dataWithTag.length - 16);
  const tag = dataWithTag.slice(dataWithTag.length - 16);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv, additionalData: new TextEncoder().encode(aad), tagLength: 128 },
    key,
    concatBytes(body, tag)
  );
  return new Uint8Array(plain);
}

// 用账号密码解开主密钥，再解密 9 个数据分片并组装 DB
async function unlockData(user, pass) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('当前环境不支持 Web Crypto，请在 HTTPS 或 localhost 下访问');
  }
  const KR = window.XWK_KEYRING;
  if (!KR) throw new Error('密钥环缺失，页面文件不完整');
  const w = KR.keys[user];
  if (!w) throw new Error('该账号未授权访问数据');

  // 1. 密码 -> KEK -> DEK
  const kek = await deriveKEK(pass, b64ToBytes(w.salt), KR.iter);
  const dekBytes = await gcmDecrypt(kek, b64ToBytes(w.iv), b64ToBytes(w.data), user);
  const dek = await crypto.subtle.importKey('raw', dekBytes, { name: 'AES-GCM' }, false, ['decrypt']);

  // 2. 解密分片
  const files = window.XWK_DATA_FILES || [1,2,3,4,5,6,7,8,9].map(i => 'data' + i + '.enc');
  const parts = {};
  for (let i = 0; i < files.length; i++) {
    const name = files[i];
    const idx = parseInt(String(name).replace(/\D/g, ''), 10) || (i + 1);
    const res = await fetch('static/data/' + name, { cache: 'no-store' });
    if (!res.ok) throw new Error('数据分片 ' + name + ' 加载失败（' + res.status + '）');
    const buf = new Uint8Array(await res.arrayBuffer());
    const plain = await gcmDecrypt(dek, buf.slice(0, 12), buf.slice(12), 'data' + idx);
    parts[idx] = JSON.parse(new TextDecoder().decode(plain));
  }

  // 3. 组装
  buildDBFromParts(parts);
  if (!DB.industries || !DB.industries.length) throw new Error('解密后数据为空，请检查密钥是否匹配');
  return true;
}

function initApp(acc) {
  const lv = $('#loginView');
  const av = $('#appView');
  if (lv) lv.hidden = true;
  if (av) av.hidden = false;
  const unEl = $('#userName');
  const urEl = $('#userRole');
  const uaEl = $('#userAvatar');
  if (unEl) unEl.textContent = acc.name;
  if (urEl) urEl.textContent = acc.role === 'admin' ? '管理员' : '浏览者';
  if (uaEl) uaEl.textContent = acc.name[0];
  try { renderNav(); } catch(e) { console.error('渲染导航失败:', e); }
  try { renderMeta(); } catch(e) { console.error('渲染元信息失败:', e); }
  
  // 初始化 hash 路由
  initHashRoute();
  // 初始化快捷键
  initShortcuts();
  
  // 从 hash 读取初始页面，否则默认仪表盘
  const hashPage = getHashPage();
  try { go(hashPage || 'dashboard'); } catch(e) { console.error('页面跳转失败:', e); }
}

// Hash 路由支持
function initHashRoute() {
  window.addEventListener('hashchange', function() {
    const page = getHashPage();
    if (page && PAGES[page] && page !== S.page) {
      go(page, true);
    }
  });
}

function getHashPage() {
  const h = location.hash.replace('#/', '').replace('#', '');
  return h || '';
}

function setHashPage(page) {
  const target = '#/' + page;
  if (location.hash !== target) {
    location.hash = target;
  }
}

// 快捷键支持
function initShortcuts() {
  document.addEventListener('keydown', function(e) {
    // Ctrl/Cmd + K 聚焦搜索框
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const searchInput = document.getElementById('globalSearch');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    }
    // ESC 关闭弹窗
    if (e.key === 'Escape') {
      // 关闭所有 modal
      const modals = document.querySelectorAll('[style*="position:fixed"][style*="z-index:1000"]');
      modals.forEach(m => {
        if (m.style.display !== 'none') m.remove();
      });
      // 关闭详情抽屉
      const drawers = document.querySelectorAll('.drawer');
      drawers.forEach(d => { if (d.style.display !== 'none') d.style.display = 'none'; });
    }
    // Ctrl/Cmd + F 行业对比
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && S.compare.length > 0) {
      e.preventDefault();
      go('compare');
    }
  });
}


async function doLogin() {

  const u = ($('#loginUser').value || '').trim();

  const p = ($('#loginPass').value || '');

  const acc = ACCOUNTS.find(a => a.user === u);

  if (!acc) {
    const errEl = $('#loginErr');
    if (errEl) errEl.textContent = '账号或密码不正确';
    return false;
  }

  const hash = await sha256(p);
  if (hash !== acc.pass_hash) {
    const errEl = $('#loginErr');
    if (errEl) errEl.textContent = '账号或密码不正确';
    return false;
  }

  // ---- 校验通过，解密业务数据（约 10MB，需要数秒）----
  const decryptErr = $('#loginErr');
  const decryptBtn = $('#loginBtn');
  const btnOldText = decryptBtn ? decryptBtn.textContent : '';
  try {
    if (decryptErr) { decryptErr.style.color = '#1d4ed8'; decryptErr.textContent = '身份已确认，正在解密数据…'; }
    if (decryptBtn) { decryptBtn.disabled = true; decryptBtn.textContent = '解密中…'; }
    await unlockData(u, p);
  } catch (err) {
    console.error('[解密失败]', err);
    if (decryptErr) {
      decryptErr.style.color = '';
      decryptErr.textContent = '数据解密失败：' + (err && err.message ? err.message : String(err));
    }
    if (decryptBtn) { decryptBtn.disabled = false; decryptBtn.textContent = btnOldText; }
    return false;
  }
  if (decryptErr) { decryptErr.style.color = ''; decryptErr.textContent = ''; }
  if (decryptBtn) { decryptBtn.disabled = false; decryptBtn.textContent = btnOldText; }

  try { localStorage.removeItem('xwk_edits_v4'); localStorage.removeItem('xwk_saved_v2'); localStorage.removeItem('xwk_recent_v2'); } catch(e) {}

  S.user = acc;

  // 持久化登录状态（仅session级，关闭浏览器后需重新登录）
  try {
    sessionStorage.setItem('xwk_user_v4', JSON.stringify({ user: acc.user, name: acc.name, role: acc.role, can_edit: acc.can_edit, can_manage: acc.can_manage }));
  } catch(e) {}

  initApp(acc);

  return false;

}



$('#loginForm').onsubmit = (e) => { e.preventDefault(); return doLogin(); };

$('#loginBtn').onclick = (e) => { e.preventDefault(); return doLogin(); };

$('#loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doLogin(); } });



$('#userMenu').onclick = (e) => {

  if (e.target.dataset.act === 'logout') {

    S.user = null;
    try { localStorage.removeItem('xwk_user_v4'); sessionStorage.removeItem('xwk_user_v4'); } catch(e) {}

    $('#appView').hidden = true;

    $('#loginView').hidden = false;

    $('#loginUser').value = '';

    $('#loginPass').value = '';

  }

};

$('.userbox').onclick = () => $('#userMenu').classList.toggle('show');

document.addEventListener('click', (e) => {

  if (!e.target.closest('.userbox')) $('#userMenu').classList.remove('show');

});



$('#navToggle').onclick = () => $('.sidebar').classList.toggle('open');



function renderMeta() {

  const m = DB.meta;

  $('#metaMini').innerHTML = `<b>${m.industry_count}</b> 行业 · <b>${m.job_count}</b> 职业 · <b>${m.city_count}</b> 城市`;

  $('#dataUpdate').innerHTML = `<span class="dot"></span>数据更新：${m.version} · ${m.last_updated}`;

}



// ================================================================== 看板

function pageDashboard(c) {

  const q = S.dash;

  const inds = applyEdits('industries', DB.industries), jobs = applyEdits('jobs', DB.jobs), risks = DB.city_risks, salary = DB.salary;

  const cities = DB.cities;

  const catCount = new Set(inds.map(i => i['行业大类'])).size;

  const highRisk = risks.filter(r => normLv(r['风险层级']) === 'D').length;

  const highDemand = Object.values(salary).filter(s => s.demand === '高').length;

  const avgSalary = Math.round(Object.values(salary).reduce((a,s) => a + (s.monthly_median||0), 0) / Math.max(1, Object.keys(salary).length));



  c.innerHTML = `

    <div class="dash-stats">

      <div class="stat-card s-blue" data-tip="覆盖170个细分行业&#10;分布在20个大类&#10;每个行业配套城市风险/岗位/薪资">

        <div class="stat-glow"></div>

        <div class="stat-top"><div class="stat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4"/><path d="M9 9v.01M9 12v.01M9 15v.01M9 18v.01"/></svg></div><div class="stat-tag">行业</div></div>

        <div class="stat-val">${inds.length}</div>

        <div class="stat-lbl">细分行业</div>

        <div class="stat-spark"><div class="sp-bar" style="height:40%"></div><div class="sp-bar" style="height:65%"></div><div class="sp-bar" style="height:50%"></div><div class="sp-bar" style="height:80%"></div><div class="sp-bar" style="height:60%"></div><div class="sp-bar" style="height:100%"></div></div>

        <div class="stat-sub">${catCount}个大类</div>

      </div>

      <div class="stat-card s-green" data-tip="975个职业岗位&#10;每个岗位含电核话术/证据/破绽&#10;支持跨行业薪资对比">

        <div class="stat-glow"></div>

        <div class="stat-top"><div class="stat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg></div><div class="stat-tag">职业</div></div>

        <div class="stat-val">${jobs.length}</div>

        <div class="stat-lbl">职业岗位</div>

        <div class="stat-spark"><div class="sp-bar" style="height:55%"></div><div class="sp-bar" style="height:70%"></div><div class="sp-bar" style="height:45%"></div><div class="sp-bar" style="height:90%"></div><div class="sp-bar" style="height:75%"></div><div class="sp-bar" style="height:85%"></div></div>

        <div class="stat-sub">${highDemand}个高需求</div>

      </div>

      <div class="stat-card s-purple" data-tip="20个核心城市&#10;含一线/新一线/重点二线&#10;每个城市×行业风险数据">

        <div class="stat-glow"></div>

        <div class="stat-top"><div class="stat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></div><div class="stat-tag">城市</div></div>

        <div class="stat-val">${cities.length}</div>

        <div class="stat-lbl">覆盖城市</div>

        <div class="stat-spark"><div class="sp-bar" style="height:60%"></div><div class="sp-bar" style="height:50%"></div><div class="sp-bar" style="height:85%"></div><div class="sp-bar" style="height:70%"></div><div class="sp-bar" style="height:95%"></div><div class="sp-bar" style="height:55%"></div></div>

        <div class="stat-sub">${risks.length}条风险记录</div>

      </div>

      <div class="stat-card s-orange" data-tip="975条薪资数据&#10;含月薪中位数/区间/趋势&#10;含购买力指数PPI">

        <div class="stat-glow"></div>

        <div class="stat-top"><div class="stat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div><div class="stat-tag">薪资</div></div>

        <div class="stat-val">${(avgSalary/1000).toFixed(1)}<span class="stat-unit">k</span></div>

        <div class="stat-lbl">平均月薪</div>

        <div class="stat-spark"><div class="sp-bar" style="height:35%"></div><div class="sp-bar" style="height:50%"></div><div class="sp-bar" style="height:60%"></div><div class="sp-bar" style="height:75%"></div><div class="sp-bar" style="height:85%"></div><div class="sp-bar" style="height:100%"></div></div>

        <div class="stat-sub">基准中位数</div>

      </div>

      <div class="stat-card s-red" data-tip="风险评级C级记录数&#10;评分>60自动预警&#10;需重点尽调">

        <div class="stat-glow"></div>

        <div class="stat-top"><div class="stat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div><div class="stat-tag">风控</div></div>

        <div class="stat-val">${highRisk}</div>

        <div class="stat-lbl">高风险记录</div>

        <div class="stat-spark"><div class="sp-bar" style="height:30%"></div><div class="sp-bar" style="height:45%"></div><div class="sp-bar" style="height:25%"></div><div class="sp-bar" style="height:60%"></div><div class="sp-bar" style="height:40%"></div><div class="sp-bar" style="height:35%"></div></div>

        <div class="stat-sub">D级</div>

      </div>

    </div>



    <div class="qbar">

      <div class="qbox">

        <div class="qt"><span class="n">1</span>行业查询</div>

        <div class="ind-search-row" style="display:flex;gap:8px;align-items:center">
          <select id="catSelect" name="off-catSelect" class="cat-select q-input" style="flex:0 0 200px">
            <option value="">— 选择大类 —</option>
          </select>
          <input type="text" id="qInd" name="off-qInd" class="q-input" autocomplete="off" placeholder="输入行业编号或名称（如 火锅、IT）" value="${esc(q.industry)}" style="flex:1;min-width:0">
        </div>

        <div class="qmeta" id="mInd">请先选择大类或输入关键词</div>

        <div class="chipbar" id="chInd"></div>

        <div class="qhint" id="hInd"></div>

      </div>

      <div class="qbox">

        <div class="qt"><span class="n">2</span>职业搜索</div>

        <input type="text" id="qJob" name="off-qJob" autocomplete="off" placeholder="输入职位关键词（如 技术员、店长、司机）" value="${esc(q.job)}" ${q.ci.size ? '' : 'disabled'}>

        <div class="qmeta" id="mJob">—</div>

        <div class="chipbar" id="chJob"></div>

        <div class="qhint" id="hJob"></div>

      </div>

      <div class="qbox">

        <div class="qt"><span class="n">3</span>城市筛选</div>

        <input type="text" id="qCity" name="off-qCity" autocomplete="off" placeholder="输入城市或定位关键词（如 重庆、港口）" value="${esc(q.city)}">

        <div class="qmeta" id="mCity">—</div>

        <div class="chipbar" id="chCity"></div>

        <div class="qhint" id="hCity"></div>

      </div>

    </div>



    <div class="statusline" id="statusLine">

      <span>请选择筛选条件后点击「查询数据」</span>

      <span class="act">

        <button class="btn sm" id="bReset">重置全部</button>

        <button class="btn green sm" id="bQuery">查询数据</button>

      </span>

    </div>

    <div id="dashBody"></div>

  `;



  const deb = debounce(() => updateChips(), 220);

  $('#qInd').oninput = (e) => { S.dash.industry = e.target.value; deb(); };

  // 大类下拉菜单
  const catSel = $('#catSelect');
  if (catSel) {
    // 填充选项
    const allCats2 = [...new Set(inds.map(r => r['行业大类'] || '其他'))].sort();
    allCats2.forEach(cat => {
      const cnt = inds.filter(r => (r['行业大类'] || '其他') === cat).length;
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = `${cat} (${cnt})`;
      catSel.appendChild(opt);
    });
    // 恢复选中状态
    if (S.dash._catFilter) catSel.value = S.dash._catFilter;
    catSel.onchange = (e) => {
      S.dash._catFilter = e.target.value;
      if (S.dash.industry) { S.dash.industry = ''; $('#qInd').value = ''; }
      updateChips();
    };
  }

  $('#qJob').oninput = (e) => { S.dash.job = e.target.value; deb(); };

  $('#qCity').oninput = (e) => { S.dash.city = e.target.value; deb(); };

  $('#bReset').onclick = () => {

    S.dash.industry = ''; S.dash.job = ''; S.dash.city = '';
    S.dash.ci = new Set(); S.dash.cj = new Set(); S.dash.cc = new Set();
    S.dash.queried = false;

    go('dashboard');

  };

  $('#bQuery').onclick = () => { S.dash.queried = true; toast('查询', '行业' + S.dash.ci.size + ' 职业' + S.dash.cj.size + ' 城市' + S.dash.cc.size); renderDash(); };

  updateChips();

  if (q.queried) {

    renderDash();

  } else {

    renderDashPreview();

  }

}



function renderDashPreview() {

  const industries = applyEdits('industries', DB.industries);

  const recent = industries.slice(0, 10);

  // 行业分布饼图
  const pieHtml = renderDashPie(industries, '行业分布');

  let h = '<div class="dash-grid" style="grid-template-columns:1fr;gap:16px;margin-bottom:16px;">';
  h += '<div class="card"><div class="card-bd"><div class="sec-h">🏢 行业大类分布</div>' + pieHtml + '</div></div>';
  h += '</div>';

  h += '<div class="card"><div class="card-bd"><div class="sec-h">最近行业记录（共' + industries.length + '条）</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>行业编号</th><th>行业大类</th><th>细分行业</th><th>风险</th><th>毛利率</th></tr></thead><tbody>';

  for (const r of recent) {

    h += '<tr><td>' + esc(r['行业编号']) + '</td><td>' + esc(r['行业大类']) + '</td><td>' + esc(r['细分行业']) + '</td><td>' + esc(normLv(r['风险层级']) || '—') + '</td><td>' + esc(r['毛利率区间'] || '—') + '</td></tr>';

  }

  h += '</tbody></table></div><p class="hint" style="margin-top:10px">以上为前10条行业记录预览。选择筛选条件后点击「查询数据」查看完整结果。</p></div></div>';

  $('#dashBody').innerHTML = h;

}





function updateChips() {

  const q = S.dash;

  const industries = applyEdits('industries', DB.industries);



  // 行业候选

  let indCandidates = [];

  // 大类筛选逻辑：只在选中大类或输入关键词时才显示细分行业
  const allCats = [...new Set(industries.map(r => r['行业大类'] || '其他'))].sort();
  let activeCat = S.dash._catFilter || '';

  if (q.industry.trim()) {
    // 输入关键词：搜索匹配的行业
    const kw = q.industry.trim().toLowerCase();
    indCandidates = industries.filter(r =>
      r['行业编号'].toLowerCase().includes(kw) ||
      fuzzyMatch(r['细分行业'], kw) ||
      fuzzyMatch(r['行业大类'], kw) ||
      fuzzyMatch(r['职业标签串'] || '', kw)
    );
  } else if (activeCat) {
    // 选中大类：显示该大类下所有细分行业
    indCandidates = industries.filter(r => (r['行业大类'] || '其他') === activeCat);
  } else {
    // 未输入关键词、未选大类：不显示任何细分行业
    indCandidates = [];
  }

  // 行业提示词
  if (q.industry.trim() && !indCandidates.length) {
    $('#hInd').innerHTML = '未找到匹配行业，试试其他关键词如：建筑、餐饮、物流、IT';
  } else if (q.industry.trim() && indCandidates.length) {
    $('#hInd').innerHTML = `命中 <b>${indCandidates.length}</b> 个行业，点击标签可多选`;
  } else if (activeCat) {
    $('#hInd').innerHTML = `当前大类：<b>${esc(activeCat)}</b>，共 ${indCandidates.length} 个细分行业，点击标签可多选`;
  } else {
    $('#hInd').innerHTML = '请先选择大类或输入关键词搜索';
  }

  $('#mInd').innerHTML = q.ci.size ? `已选 <b>${q.ci.size}</b> 个行业` : (indCandidates.length ? `命中 <b>${indCandidates.length}</b> 个行业` : '请先选择大类或输入关键词');

  // 细分行业标签：只在有候选时才显示
  $('#chInd').innerHTML = indCandidates.length ? indCandidates.map(r => {
    const on = q.ci.has(r['行业编号']);
    return `<span class="chip${on ? ' on' : ''}" data-code="${esc(r['行业编号'])}">${esc(r['行业编号'])} ${esc(r['细分行业'])}</span>`;
  }).join('') : '<span class="hint" style="color:#9ca3af">未选择大类或输入关键词，暂无细分行业标签</span>';

  $$('#chInd .chip').forEach(el => {

    el.onclick = () => {

      const code = el.getAttribute('data-code');

      if (q.ci.has(code)) { q.ci.delete(code); }

      else { q.ci.add(code); toast('已选行业', code + ' (共' + q.ci.size + '个)'); }

      updateChips();

    };

  });



  // 职业候选

  const selectedInds = q.ci.size ? industries.filter(r => q.ci.has(r['行业编号'])) : [];

  const jobPool = q.ci.size ? DB.jobs.filter(j => q.ci.has(j['行业编号'])) : [];

  let jobCandidates = [];

  if (q.job.trim() && jobPool.length) {

    const kw = q.job.trim().toLowerCase();

    jobCandidates = jobPool.filter(j => fuzzyMatch(j['常见职位'], kw)).slice(0, 15);

  } else if (jobPool.length) {

    jobCandidates = jobPool.slice(0, 12);

  }



  $('#qJob').disabled = !q.ci.size;

  $('#mJob').innerHTML = q.ci.size

    ? `本行业 <b>${jobPool.length}</b> 个职位${q.cj.size ? ` · 已选 <b>${q.cj.size}</b>` : ''}`

    : '请先选定行业';

  $('#hJob').innerHTML = q.ci.size ? `共 ${jobPool.length} 个职位，点击标签可多选` : '先选择行业后可搜索职业';

  $('#chJob').innerHTML = jobCandidates.map(j => {

    const on = q.cj.has(j['常见职位']);

    return `<span class="chip${on ? ' on' : ''}" data-j="${esc(j['常见职位'])}">${esc(j['常见职位'])}</span>`;

  }).join('') || '<span class="hint">—</span>';

  $$('#chJob .chip').forEach(el => {

    el.onclick = () => {

      const jn = el.dataset.j;

      if (q.cj.has(jn)) q.cj.delete(jn); else q.cj.add(jn);

      updateChips();

    };

  });



  // 城市候选

  const cities = DB.cities;

  let cityCandidates = [];

  if (q.city.trim()) {

    const kw = q.city.trim().toLowerCase();

    cityCandidates = cities.filter(r =>

      fuzzyMatch(r['城市名称'], kw) ||

      fuzzyMatch(r['定位标签'] || '', kw)

    );

  } else {

    cityCandidates = cities;

  }



  $('#mCity').innerHTML = q.cc.size ? `已选 <b>${q.cc.size}</b> 个城市` : `共 <b>${cities.length}</b> 个城市`;

  $('#hCity').innerHTML = '点击城市标签可多选，不选则默认全部';

  $('#chCity').innerHTML = cityCandidates.map(r => {

    const on = q.cc.has(r['城市名称']);

    return `<span class="chip${on ? ' on' : ''}" data-c="${esc(r['城市名称'])}" title="${esc(r['定位标签'] || '')}">${esc(r['城市名称'])}</span>`;

  }).join('');

  $$('#chCity .chip').forEach(el => {

    el.onclick = () => {

      const cn = el.dataset.c;

      if (q.cc.has(cn)) q.cc.delete(cn); else q.cc.add(cn);

      updateChips();

    };

  });

}



function renderDash() {

  const q = S.dash;

  const industries = applyEdits('industries', DB.industries);

  const jobs = applyEdits('jobs', DB.jobs);

  const modes = applyEdits('modes', DB.modes);

  const risks = applyEdits('city_risks', DB.city_risks);



  const selectedCodes = q.ci.size ? [...q.ci] : [];

  const indRecords = selectedCodes.length ? industries.filter(r => q.ci.has(r['行业编号'])) : [];

  const selectedJobs = q.cj.size ? [...q.cj] : [];

  const selectedCities = q.cc.size ? [...q.cc] : [];

  const allCities = DB.cities.map(c => c['城市名称']);



  // 状态栏

  const indLabel = indRecords.length ? indRecords.map(r => r['细分行业']).join('、') : '全部';

  const jobLabel = selectedJobs.length ? selectedJobs.join('、') : '全部';

  const cityLabel = selectedCities.length ? selectedCities.join('、') : '全部';

  $('#statusLine').innerHTML =

    `<span>行业：<b>${esc(indLabel)}</b><span class="sep">｜</span>` +

    `职业：<b>${esc(jobLabel)}</b><span class="sep">｜</span>` +

    `城市：<b>${esc(cityLabel)}</b></span>` +

    `<span class="act">

      <button class="btn sm" id="bExport">📥 导出</button>

      <button class="btn sm" id="bReset2">重置全部</button>

      <button class="btn green sm" id="bQuery2">查询数据</button>

    </span>`;

  $('#bReset2').onclick = () => {

    S.dash.industry = ''; S.dash.job = ''; S.dash.city = '';
    S.dash.ci = new Set(); S.dash.cj = new Set(); S.dash.cc = new Set();
    S.dash.queried = false;

    go('dashboard');

  };

  $('#bQuery2').onclick = () => {

    S.dash.queried = true;

    toast('查询', '行业' + S.dash.ci.size + ' 职业' + S.dash.cj.size + ' 城市' + S.dash.cc.size);

    renderDash();

  };

  const expBtn = $('#bExport');

  if (expBtn) expBtn.onclick = () => showExportModal(indRecords, selectedJobs, selectedCities, jobs, risks);



  let html = '';



  // 识别编号

  if (indRecords.length === 1) {

    const ind = indRecords[0];

    const jobCount = jobs.filter(j => j['行业编号'] === ind['行业编号']).length;

    const modeCount = modes.filter(m => m['行业编号'] === ind['行业编号']).length;

    html += `<div class="idbox fade-in">

      <div><div class="k">识别编号</div><div class="v code">${esc(ind['行业编号'])}</div></div>

      <div><div class="k">行业名称</div><div class="v">${esc(ind['细分行业'])}</div></div>

      <div><div class="k">行业大类</div><div class="v">${esc(ind['行业大类'])}</div></div>

      <div><div class="k">职业 / 模式 / 城市</div><div class="v">${jobCount} / ${modeCount} / ${allCities.length}</div></div>

    </div>`;

  } else if (indRecords.length > 1) {

    html += `<div class="idbox fade-in">

      <div><div class="k">已选行业</div><div class="v">${indRecords.length} 个</div></div>

      <div><div class="k">行业列表</div><div class="v" style="font-size:13px;font-weight:400">${indRecords.map(r => esc(r['行业编号'] + ' ' + r['细分行业'])).join('、')}</div></div>

    </div>`;

  }



  // 01 行业档案

  if (indRecords.length) {

    html += sec01(indRecords, industries);

  }



  // 02 经营模式

  if (indRecords.length || selectedCodes.length) {

    const modeRecords = selectedCodes.length ? modes.filter(m => q.ci.has(m['行业编号'])) : [];

    html += sec02(modeRecords);

  }



  // 03 前景利润淡旺季

  if (indRecords.length) {

    html += sec03(indRecords);

  }



  // 04 在职客户岗位核实

  if (selectedCodes.length) {

    let jobRecords;

    if (selectedJobs.length) {

      jobRecords = jobs.filter(j => q.ci.has(j['行业编号']) && q.cj.has(j['常见职位']));

    } else {

      jobRecords = jobs.filter(j => q.ci.has(j['行业编号']));

    }

    html += sec04(jobRecords, selectedJobs);



    // 06 薪资趋势（在审核信息下面）

    if (selectedJobs.length) {

      html += sec06(selectedCodes.length === 1 ? selectedCodes[0] : '', selectedJobs, selectedCities);

    } else if (jobRecords.length) {

      html += sec06(selectedCodes.length === 1 ? selectedCodes[0] : '', jobRecords.slice(0, 3).map(j => j['常见职位']), selectedCities);

    }

  }



  // 05 城市风险分级

  if (selectedCodes.length || selectedCities.length) {

    let riskRecords;

    if (selectedCodes.length && selectedCities.length) {

      riskRecords = risks.filter(r => q.ci.has(r['行业编号']) && q.cc.has(r['城市']));

    } else if (selectedCodes.length) {

      riskRecords = risks.filter(r => q.ci.has(r['行业编号']));

    } else {

      riskRecords = risks.filter(r => q.cc.has(r['城市']));

    }

    html += sec05(riskRecords, selectedCodes.length > 0, selectedCities);

  }



  if (!html) {

    html = '<div class="empty"><span class="big">📋</span>请至少选择一个行业或城市后查询数据</div>';

  }



  $('#dashBody').innerHTML = html;

  bindGroupToggles($('#dashBody'));

}



function cardHead(no, title, sub) {

  const icons = {

    'A':'📊','I':'💎','J':'📅','M':'📜','T':'⚖',

    'G':'🔥','N':'🔀','O':'🔍','U':'🎯',

    'C':'🏙','P':'💰',

    'F':'💵','B':'⚠','D':'🗺','E':'🏆','R':'🎯',

    'K':'📈','L':'💵','S':'⚡',

    '01':'📋','02':'👥','03':'🌍','04':'📐',

  };

  const ico = icons[no] || '📈';

  return `<div class="card-hd"><h3><span class="no">${no}</span><span class="card-ico">${ico}</span>${esc(title)}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

}



function sec01(inds, allInds) {

  let body = '';

  for (const ind of inds) {

    const k = ind['行业编号'];

    body += `<div class="grp">

      <div class="grp-hd"><span class="idx">◆</span>${esc(ind['细分行业'])}<span class="rt">${esc(ind['行业大类'])} · ${esc(k)}</span></div>

      <div class="grp-bd"><table class="kv">${F.industries_01.map(f => {

        const v = ind[f] || '';

        return `<tr><th>${esc(lb(f))}</th><td>${v ? nl2br(v) : '<span style="color:#cbd5e1">—</span>'}</td></tr>`;

      }).join('')}</table></div></div>`;

  }

  return `<div class="card fade-in">${cardHead('01', '行业档案', `${inds.length} 个行业`)}

    <div class="card-bd"><div class="grp-list">${body}</div></div></div>`;

}



function sec02(modes) {

  if (!modes.length) return '';

  const body = `<div class="grp-list">${modes.map((m, i) => {

    return `<div class="grp collapsed">

      <div class="grp-hd"><span class="idx">◆</span>${esc(m['细分模式'])}

        <span class="rt">第 ${i + 1} / ${modes.length} 条</span><span class="toggle">▸</span></div>

      <div class="grp-bd"><table class="kv">${F.modes_02.map(f => {

        const v = m[f] || '';

        return `<tr><th>${esc(lb(f))}</th><td>${v ? nl2br(v) : '<span style="color:#cbd5e1">—</span>'}</td></tr>`;

      }).join('')}</table></div></div>`;

  }).join('')}</div>`;

  return `<div class="card fade-in">${cardHead('02', '经营模式', `共 ${modes.length} 条`)}

    <div class="card-bd">${body}</div></div>`;

}



function sec03(inds) {

  let body = '';

  for (const ind of inds) {

    body += `<div class="grp">

      <div class="grp-hd"><span class="idx">◆</span>${esc(ind['细分行业'])}<span class="toggle">▾</span></div>

      <div class="grp-bd"><table class="kv">

        <tr><th>${esc(lb('前景趋势判断'))}</th><td colspan="3">${ind['前景趋势判断'] ? nl2br(ind['前景趋势判断']) : '<span style="color:#cbd5e1">—</span>'}</td></tr>

        <tr><th>${esc(lb('毛利率区间'))}</th><td style="width:40%">${ind['毛利率区间'] ? nl2br(ind['毛利率区间']) : '<span style="color:#cbd5e1">—</span>'}</td>

          <th style="width:100px">${esc(lb('净利率区间'))}</th><td>${ind['净利率区间'] ? nl2br(ind['净利率区间']) : '<span style="color:#cbd5e1">—</span>'}</td></tr>

        <tr><th>${esc(lb('旺季月份'))}</th><td>${ind['旺季月份'] ? nl2br(ind['旺季月份']) : '<span style="color:#cbd5e1">—</span>'}</td>

          <th>${esc(lb('淡季月份'))}</th><td>${ind['淡季月份'] ? nl2br(ind['淡季月份']) : '<span style="color:#cbd5e1">—</span>'}</td></tr>

        <tr><th>${esc(lb('季节性资金缺口高峰'))}</th><td colspan="3">${ind['季节性资金缺口高峰'] ? nl2br(ind['季节性资金缺口高峰']) : '<span style="color:#cbd5e1">—</span>'}</td></tr>

        <tr><th>${esc(lb('主要经营风险'))}</th><td colspan="3">${ind['主要经营风险'] ? nl2br(ind['主要经营风险']) : '<span style="color:#cbd5e1">—</span>'}</td></tr>

        <tr><th>${esc(lb('政策与外部驱动'))}</th><td colspan="3">${ind['政策与外部驱动'] ? nl2br(ind['政策与外部驱动']) : '<span style="color:#cbd5e1">—</span>'}</td></tr>

      </table></div></div>`;

  }

  return `<div class="card fade-in">${cardHead('03', '前景、利润、淡旺季', '含毛利率/净利率/旺淡季')}

    <div class="card-bd"><div class="grp-list">${body}</div></div></div>`;

}



function sec04(jobs, selectedJobs) {

  if (!jobs.length) {

    return `<div class="card fade-in">${cardHead('04', '在职客户岗位核实', '无匹配职位')}

      <div class="card-bd"><div class="empty"><span class="big">👥</span>未选中职业或该行业无匹配职位</div></div></div>`;

  }

  const body = `<div class="grp-list">${jobs.map((j, i) => {

    return `<div class="grp">

      <div class="grp-hd"><span class="idx">◆</span>${esc(j['常见职位'])}

        <span class="rt">第 ${i + 1} / ${jobs.length} 条</span><span class="toggle">▾</span></div>

      <div class="grp-bd"><table class="kv">${F.jobs_04.map(f => {

        const v = j[f] || '';

        return `<tr><th>${esc(lb(f))}</th><td>${v ? nl2br(v) : '<span style="color:#cbd5e1">—</span>'}</td></tr>`;

      }).join('')}</table></div></div>`;

  }).join('')}</div>`;

  return `<div class="card fade-in">${cardHead('04', '在职客户岗位核实', `显示 ${jobs.length} 个职位`)}

    <div class="card-bd">${body}</div></div>`;

}



function sec05(rows, hasInd, selectedCities) {
  if (!rows.length) {
    return `<div class="card fade-in">${cardHead('05', '城市风险分级（A 低 → D 高）', '无匹配')}
      <div class="card-bd"><div class="empty"><span class="big">🏙</span>无匹配城市风险数据</div></div></div>`;
  }
  
  const lvOrder = { 'A': 1, 'B': 2, 'C': 3, 'D': 4 };
  const sortedRows = [...rows].sort((a, b) => (lvOrder[a['风险层级']] || 9) - (lvOrder[b['风险层级']] || 9));
  
  const body = `<div class="city-risk-grid">
    ${sortedRows.map((r, i) => {
      const lv = r['风险层级'] || 'C';
      const lvCls = lvClass(lv);
      const lvName = normLv(lv) || '—';
      const score = parseInt(r['风险评分']) || 0;
      const scorePct = Math.min(Math.max(score, 0), 100);
      const hasDetail = hasInd && r['行业优势'] && r['主要风险点'] && r['风控建议'];
      const dataNote = r['数据说明'] || '';
      const lvDesc = {
        'A': '低风险 · 优势产业',
        'B': '中低风险 · 基础较好',
        'C': '中等风险 · 审慎介入',
        'D': '高风险 · 严格把控'
      }[lv] || '';
      
      return `<div class="city-risk-card crc-${lv.toLowerCase()}" data-idx="${i}">
        <div class="crc-head">
          <div class="crc-city" onclick="jumpCityRisk('${esc(r['城市'])}')" title="查看${esc(r['城市'])}风险分析">${esc(r['城市'])}</div>
          <span class="lv ${lvCls} lv-lg" title="${esc(lvDesc)}">${lvName}级</span>
        </div>
        
        ${hasInd ? `
        <div class="crc-score-wrap">
          <div class="crc-score-row">
            <span class="crc-score-label">综合风险评分</span>
            <span class="crc-score-val">${score}<span>分 / 100</span></span>
          </div>
          <div class="crc-score-bar">
            <div class="crc-score-fill" style="width:${scorePct}%"></div>
          </div>
        </div>
        
        ${dataNote ? `<div class="crc-data-note">${esc(dataNote)}</div>` : ''}
        
        <div class="crc-body">
          <div class="crc-section">
            <div class="crc-label">✅ 行业优势</div>
            <div class="crc-text">${esc(r['行业优势'] || '—')}</div>
          </div>
          <div class="crc-section">
            <div class="crc-label">⚠️ 主要风险点</div>
            <div class="crc-text">${esc(r['主要风险点'] || '—')}</div>
          </div>
          <div class="crc-section">
            <div class="crc-label">🔍 风控建议</div>
            <div class="crc-text">${esc(r['风控建议'] || '—')}</div>
          </div>
          <div class="crc-section crc-collapsible" id="crc-detail-${i}">
            <div class="crc-label">📊 依据与尽调要点</div>
            <div class="crc-text crc-basis">${esc(r['依据与尽调要点'] || '—')}</div>
          </div>
        </div>
        
        ${hasDetail ? `<div class="crc-toggle" onclick="toggleCrcDetail(${i})">
          <span>查看尽调要点</span>
          <span class="crc-toggle-ico">▼</span>
        </div>` : ''}
        ` : `<div class="crc-empty">请先选定行业查看详细分析</div>`}
      </div>`;
    }).join('')}
  </div>`;
  
  return `<div class="card fade-in">${cardHead('05', '城市风险分级（A 低 → D 高）', `${rows.length} 个城市 · 点击城市名跳转分析`)}
    <div class="card-bd">${body}
      <div class="legend">
        <span><i style="background:var(--lv-a-bg);border:1px solid var(--lv-a)"></i>A 低风险·优势产业</span>
        <span><i style="background:var(--lv-b-bg);border:1px solid var(--lv-b)"></i>B 中低风险·基础较好</span>
        <span><i style="background:var(--lv-c-bg);border:1px solid var(--lv-c)"></i>C 中等风险·一般</span>
        <span><i style="background:var(--lv-d-bg);border:1px solid var(--lv-d)"></i>D 高风险·谨慎介入</span>
      </div>
      <p class="hint" style="margin-top:10px;font-size:11.5px;color:#94a3b8;line-height:1.7">
        📊 数据来源：各城市统计局2025年国民经济和社会发展统计公报、2026年上半年经济运行数据，结合行业发展周期、区域产业结构、政策导向及信贷风控经验综合评定。<br>
        💡 使用建议：风险等级仅供信贷审批参考，实际决策请结合客户具体经营情况、财务状况及担保条件综合判断。
      </p>
    </div></div>`;
}

function toggleCrcDetail(idx) {
  const card = document.querySelector('.city-risk-card[data-idx="' + idx + '"]');
  if (!card) return;
  const toggle = card.querySelector('.crc-toggle span:first-child');
  const isOpen = card.classList.contains('crc-open');
  if (isOpen) {
    card.classList.remove('crc-open');
    if (toggle) toggle.textContent = '查看尽调要点';
  } else {
    card.classList.add('crc-open');
    if (toggle) toggle.textContent = '收起尽调要点';
  }
}

// V6.1 新增：点击城市名跳转风险分析页
function jumpCityRisk(cityName) {
  // 触发侧边栏风险分析导航
  const navItem = document.querySelector('.nav-item[data-page="ana-risk"]');
  if (navItem) {
    navItem.click();
    // 延迟一下后定位到该城市
    setTimeout(() => {
      const cityCell = document.querySelector(`.heat td[data-c="${cityName}"]`);
      if (cityCell) {
        cityCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
        cityCell.style.outline = '2px solid var(--c-brand)';
        setTimeout(() => { cityCell.style.outline = ''; }, 2000);
      }
    }, 300);
  }
}


// 06 薪资趋势（支持城市维度 + 购买力）

function sec06(indCode, jobNames, selectedCities) {

  if (!jobNames || !jobNames.length) return '';

  const allCities = DB.cities.map(c => c['城市名称'] || c['城市']).filter(Boolean);
  // 恢复：勾选哪个城市显示哪个城市，没勾选时默认显示前6个主要城市
  const cities = selectedCities && selectedCities.length ? selectedCities : allCities.slice(0, 6);

  const cf = DB.city_factors || {};



  const cards = jobNames.map(jn => {

    const key = indCode ? `${indCode}|${jn}` : Object.keys(DB.salary).find(k => k.endsWith('|' + jn));

    const sd = key ? DB.salary[key] : null;

    if (!sd) return '';



    const trend = sd.trend || {};

    const years = Object.keys(trend).sort();

    if (!years.length) return '';

    // 只跟选中的城市比较，不用所有城市/trend的最大值
    const allAdj = cities.map(cn => {
      const f = (cf[cn] && cf[cn].salary_factor) ? cf[cn].salary_factor : 1;
      const adj = Math.round(sd.monthly_median * f);
      const costF2 = (cf[cn] && cf[cn].cost_factor) ? cf[cn].cost_factor : 1;
      const pp = Math.round(adj / costF2);
      return { adj, pp };
    });
    const maxVal = Math.max(...allAdj.map(d => Math.max(d.adj, d.pp))) * 1.1;



    // 城市薪资对比表

    const cityRows = cities.map(cn => {

      const f = (cf[cn] && cf[cn].salary_factor) ? cf[cn].salary_factor : 1;

      const adj = Math.round(sd.monthly_median * f);

      const adjMin = Math.round(sd.monthly_min * f);

      const adjMax = Math.round(sd.monthly_max * f);

      const costF = (cf[cn] && cf[cn].cost_factor) ? cf[cn].cost_factor : 1;

      const pp = Math.round(adj / costF);

      const ppLevel = pp >= sd.monthly_median * 1.15 ? 'high' : pp <= sd.monthly_median * 0.85 ? 'low' : 'mid';

      return `<tr>

        <td class="city">${esc(cn)}</td>

        <td>${(adjMin/1000).toFixed(1)}k - ${(adjMax/1000).toFixed(1)}k</td>

        <td><b>${(adj/1000).toFixed(1)}k</b></td>

        <td>${(pp/1000).toFixed(1)}k <span class="pp-tag ${ppLevel}">${ppLevel === 'high' ? '↑高于基准' : ppLevel === 'low' ? '↓低于基准' : '≈持平'}</span></td>

        <td>${(adj*12/10000).toFixed(1)}w</td>

      </tr>`;

    }).join('');



    // 城市对比柱状图
    const cityBars = cities.map((cn, idx) => {
      const d = allAdj[idx];
      const adj = d.adj, pp = d.pp;
      const h = (adj / maxVal * 100).toFixed(1);
      const ppH = (pp / maxVal * 100).toFixed(1);

      return `<div class="city-bar-group">

        <div class="city-bar-pair">

          <div class="city-bar" title="${esc(cn)}名义薪资: ${(adj/1000).toFixed(1)}k">

            <div class="bar-fill" style="height:${h}%;background:linear-gradient(180deg,#60a5fa,#2563eb)"></div>

          </div>

          <div class="city-bar" title="${esc(cn)}购买力等值: ${(pp/1000).toFixed(1)}k">

            <div class="bar-fill" style="height:${ppH}%;background:linear-gradient(180deg,#34d399,#059669)"></div>

          </div>

        </div>

        <div class="bar-lbl">${esc(cn)}</div>
        <div class="bar-lbl-val"><span style="color:#2563eb;">${(adj/1000).toFixed(1)}k</span> / <span style="color:#059669;">${(pp/1000).toFixed(1)}k</span></div>

      </div>`;

    }).join('');



    // 年度趋势SVG面积渐变图

    const chartW = 500, chartH = 180, padL = 40, padR = 20, padT = 20, padB = 30;

    const innerW = chartW - padL - padR;

    const innerH = chartH - padT - padB;

    const vals = years.map(y => trend[y].monthly_median);

    const vMax = Math.max(...vals) * 1.15;

    const vMin = Math.min(...vals) * 0.85;

    const vRange = vMax - vMin || 1;

    

    const points = years.map((y, i) => {

      const x = padL + (innerW / (years.length - 1 || 1)) * i;

      const yv = padT + innerH - ((trend[y].monthly_median - vMin) / vRange * innerH);

      return { x, y: yv, year: y, val: trend[y].monthly_median };

    });

    

    // 面积路径

    const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');

    const areaPath = linePath + ` L${points[points.length-1].x.toFixed(1)},${(padT+innerH).toFixed(1)} L${points[0].x.toFixed(1)},${(padT+innerH).toFixed(1)} Z`;

    

    // 网格线

    const gridLines = [];

    for (let g = 0; g <= 4; g++) {

      const gy = padT + innerH / 4 * g;

      const gv = Math.round(vMax - (vRange / 4 * g));

      gridLines.push(`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${chartW-padR}" y2="${gy.toFixed(1)}" stroke="#e5e7eb" stroke-dasharray="3,3" stroke-width="0.5"/>`);

      gridLines.push(`<text x="${padL-6}" y="${gy.toFixed(1)}" text-anchor="end" dominant-baseline="middle" fill="#9ca3af" font-size="10">${(gv/1000).toFixed(0)}k</text>`);

    }

    

    // 数据点和标注

    const dataDots = points.map(p => `

      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#fff" stroke="#3b82f6" stroke-width="2">

        <animate attributeName="r" from="0" to="4" dur="0.5s" fill="freeze" begin="${points.indexOf(p)*0.1}s"/>

      </circle>

      <text x="${p.x.toFixed(1)}" y="${(p.y-10).toFixed(1)}" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="600">${(p.val/1000).toFixed(1)}k</text>

      <text x="${p.x.toFixed(1)}" y="${(padT+innerH+18).toFixed(1)}" text-anchor="middle" fill="#6b7280" font-size="11">${p.year}</text>

    `).join('');

    

    // 渐变定义

    const trendSvg = `

    <svg viewBox="0 0 ${chartW} ${chartH}" class="trend-svg" preserveAspectRatio="xMidYMid meet">

      <defs>

        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">

          <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.35"/>

          <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.02"/>

        </linearGradient>

        <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">

          <stop offset="0%" stop-color="#60a5fa"/>

          <stop offset="100%" stop-color="#2563eb"/>

        </linearGradient>

      </defs>

      ${gridLines.join('')}

      <path d="${areaPath}" fill="url(#areaGrad)" class="trend-area">

        <animate attributeName="opacity" from="0" to="1" dur="0.8s" fill="freeze"/>

      </path>

      <path d="${linePath}" fill="none" stroke="url(#lineGrad)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="trend-line">

        <animate attributeName="stroke-dasharray" from="0,1000" to="1000,0" dur="1.2s" fill="freeze"/>

      </path>

      ${dataDots}

    </svg>`;



    const firstYear = trend[years[0]];

    const lastYear = trend[years[years.length - 1]];

    const growth = firstYear && lastYear ? ((lastYear.monthly_median - firstYear.monthly_median) / firstYear.monthly_median * 100).toFixed(1) : 0;



    const demandTag = sd.demand === '高' ? 'hot' : sd.demand === '中' ? 'warm' : 'cool';

    const demandText = sd.demand === '高' ? '需求旺盛' : sd.demand === '中' ? '需求稳定' : '需求一般';



    const baseMedian = (sd.monthly_median/1000).toFixed(1);



    return `<div class="salary-card fade-in">

      <div class="card-hd"><h3><span class="no">06</span>${esc(jn)} · 薪资趋势分析</h3><div class="sub">2019-2025 · 基准薪资 ${baseMedian}k</div></div>

      <div class="salary-grid">

        <div class="salary-stat"><div class="sl">基准月薪</div><div class="sv">${baseMedian}k</div></div>

        <div class="salary-stat"><div class="sl">月薪范围</div><div class="sv">${(sd.monthly_min/1000).toFixed(1)}k<small> - ${(sd.monthly_max/1000).toFixed(1)}k</small></div></div>

        <div class="salary-stat"><div class="sl">年薪中位</div><div class="sv">${(sd.annual_median/10000).toFixed(1)}w</div></div>

        <div class="salary-stat"><div class="sl">7年增长</div><div class="sv">${growth > 0 ? '+' : ''}${growth}%</div><div class="delta ${growth > 0 ? 'up' : 'down'}">${growth > 0 ? '↑' : '↓'} ${Math.abs(growth)}%</div></div>

      </div>



      ${cities.length > 1 || (cities.length === 1 && cities[0] !== '重庆') ? `

      <div class="salary-city-chart">

        <div class="chart-title">🏙 各城市薪资 vs 购买力对比</div>

        <div class="city-bars-legend">

          <span><i style="background:#2563eb"></i>名义月薪（含城市系数调整）</span>

          <span><i style="background:#059669"></i>购买力等值（扣除生活成本后）</span>

        </div>

        <div class="salary-bars city-mode">${cityBars}</div>

      </div>

      <div class="salary-city-tbl">

        <table class="tbl compact">

          <thead><tr><th>城市</th><th>月薪范围</th><th>月薪中位</th><th>购买力等值</th><th>年薪</th></tr></thead>

          <tbody>${cityRows}</tbody>

        </table>

      </div>` : ''}



      <div class="salary-chart">

        <div class="chart-title">📈 年度薪资趋势（基准月薪中位数）</div>

        <div class="trend-chart-wrap">${trendSvg}</div>

      </div>

      <div class="salary-demand">

        <span class="dl">市场需求：</span>

        <span class="tag ${demandTag}">${demandText}</span>

        <span class="dl" style="margin-left:12px">年均增长率：</span>

        <span class="tag blue">${esc(sd.growth_rate)}</span>

        <span class="dl" style="margin-left:auto;font-size:11px;color:var(--c-tx-3)">基准薪资基于行业大类模型估算，城市薪资=基准×城市系数，购买力=名义薪资÷城市系数</span>

      </div>

    </div>`;

  }).join('');



  return cards || '';

}



function bindGroupToggles(root) {

  $$('.grp-hd', root).forEach(h => {

    h.onclick = (e) => {

      const grp = h.closest('.grp');

      if (grp) {

        grp.classList.toggle('collapsed');

        const toggle = h.querySelector('.toggle');

        if (toggle) toggle.textContent = grp.classList.contains('collapsed') ? '▸' : '▾';

      }

    };

  });



}





// ================================================================== 统计分析 — 数据准备

function getAnalyticsCtx() {

  const inds = applyEdits('industries', DB.industries);

  const jobs = applyEdits('jobs', DB.jobs);

  const modes = applyEdits('modes', DB.modes);

  const risks = applyEdits('city_risks', DB.city_risks);

  const cities = DB.cities;



  const t = {

    行业: inds.length, 门类: new Set(inds.map(r => r['行业大类'])).size,

    职业: jobs.length, 经营模式: modes.length,

    城市: cities.length, 城市风险记录: risks.length,

  };



  const catMap = {};

  for (const ind of inds) {

    const cat = ind['行业大类'] || '其他';

    if (!catMap[cat]) catMap[cat] = { count: 0, codes: [] };

    catMap[cat].count++;

    catMap[cat].codes.push(ind['行业编号']);

  }

  const cats = Object.entries(catMap).sort((a, b) => b[1].count - a[1].count);

  const catMax = cats.length ? cats[0][1].count : 1;



  const lvMap = {};

  for (const r of risks) {

    const lv = normLv(r['风险层级']) || 'C';

    lvMap[lv] = (lvMap[lv] || 0) + 1;

  }

  const lvTotal = Object.values(lvMap).reduce((a, b) => a + b, 0) || 1;



  const cityRiskMap = {};

  for (const r of risks) {

    const cn = r['城市'];

    if (!cityRiskMap[cn]) cityRiskMap[cn] = { total: 0, high: 0, mid: 0, low: 0, aLow: 0, bLow: 0 };

    cityRiskMap[cn].total++;

    const lv = normLv(r['风险层级']);

    if (lv === 'D') cityRiskMap[cn].high++;

    else if (lv === 'C') cityRiskMap[cn].mid++;

    else if (lv === 'B') { cityRiskMap[cn].bLow++; cityRiskMap[cn].low++; }

    else { cityRiskMap[cn].aLow++; cityRiskMap[cn].low++; }

  }

  const cityRows = Object.entries(cityRiskMap).sort((a, b) => b[1].high - a[1].high);



  const indRisk = [];

  const lvScore = { 'A': 1, 'B': 2, 'C': 3, 'D': 4 };

  for (const ind of inds) {

    const code = ind['行业编号'];

    const indRisks = risks.filter(r => r['行业编号'] === code);

    if (!indRisks.length) continue;

    let sum = 0, maxCity = '', maxScore = 0;

    for (const r of indRisks) {

      const lv = normLv(r['风险层级']);

      const sc = lvScore[lv] || 3;

      sum += sc;

      if (sc > maxScore) { maxScore = sc; maxCity = r['城市']; }

    }

    indRisk.push({ ...ind, 风险指数: +(sum / indRisks.length).toFixed(2), 最高风险城市: maxCity });

  }

  indRisk.sort((a, b) => b.风险指数 - a.风险指数);

  const topRisk = indRisk.slice(0, 20);

  const bestRisk = indRisk.slice(-20).reverse();



  const salaryKeys = Object.keys(DB.salary);

  const salaryStats = salaryKeys.map(k => DB.salary[k]).filter(s => s);

  const salaryBins = { '3k以下': 0, '3-5k': 0, '5-8k': 0, '8-12k': 0, '12-20k': 0, '20k以上': 0 };

  for (const s of salaryStats) {

    const m = s.monthly_median;

    if (m < 3000) salaryBins['3k以下']++;

    else if (m < 5000) salaryBins['3-5k']++;

    else if (m < 8000) salaryBins['5-8k']++;

    else if (m < 12000) salaryBins['8-12k']++;

    else if (m < 20000) salaryBins['12-20k']++;

    else salaryBins['20k以上']++;

  }

  const sMax = Math.max(1, ...Object.values(salaryBins));



  const demandMap = { '高': 0, '中': 0, '低': 0 };

  for (const s of salaryStats) {

    const d = s.demand;

    let level = '中';

    if (d === '高' || d === '中高' || d === '旺盛' || d === 'hot') level = '高';

    else if (d === '中' || d === '中等' || d === '稳定' || d === 'warm' || d === '一般') level = '中';

    else if (d === '低' || d === '较低' || d === '冷' || d === 'cool' || d === '少') level = '低';

    demandMap[level] = (demandMap[level] || 0) + 1;

  }



  return { inds, jobs, modes, risks, cities, t, cats, catMax, lvMap, lvTotal, cityRiskMap, cityRows, indRisk, topRisk, bestRisk, salaryStats, salaryBins, sMax, demandMap };

}



// ================================================================== 行业分析

function pageAnaIndustry(c) {

  const ctx = getAnalyticsCtx();

  const { inds, t, cats, catMax } = ctx;

  c.innerHTML = `

  <div class="stat-grid fade-in">

    <div class="stat"><div class="n">${t.行业}</div><div class="l">细分行业</div></div>

    <div class="stat g"><div class="n">${t.门类}</div><div class="l">行业大类</div></div>

    <div class="stat"><div class="n">${t.职业}</div><div class="l">岗位核实明细</div></div>

    <div class="stat g"><div class="n">${t.经营模式}</div><div class="l">经营模式条目</div></div>

    <div class="stat o"><div class="n">${t.城市}</div><div class="l">覆盖城市</div></div>

    <div class="stat r"><div class="n">${t.城市风险记录}</div><div class="l">行业×城市 分级记录</div></div>

  </div>

  <div class="ana-grid">

    <div class="card fade-in">${cardHead('A', '行业大类分布', `${t.行业} 个细分行业 / ${t.门类} 个大类`)}

      <div class="card-bd"><div class="bars">

        ${cats.map(([n, v]) => `<div class="bar-row">

          <div class="bl" title="${esc(v.codes.join('、'))}">${esc(n)}</div>

          <div class="bt"><div class="bf" style="width:${(v.count / catMax * 100).toFixed(1)}%"></div></div>

          <div class="bv">${v.count}</div></div>`).join('')}

      </div></div></div>

    <div class="card fade-in">${cardHead('I', '毛利率 vs 净利率 散点图', '行业利润率分布')}

      <div class="card-bd"><div class="scatter-plot" id="scatterPP"></div>

        <div class="scatter-legend">

          <span><i style="background:#059669"></i>高利润</span>

          <span><i style="background:#d97706"></i>中等利润</span>

          <span><i style="background:#dc2626"></i>低利润或亏损</span>

        </div></div></div>

    <div class="card fade-in">${cardHead('J', '旺淡季日历热力图', '12个月 × 行业大类')}

      <div class="card-bd"><div class="cal-heat" id="calHeat"></div></div></div>

    <div class="card fade-in">${cardHead('M', '政策驱动词频分析', '政策关键词统计')}

      <div class="card-bd"><div class="bars" id="policyFreq"></div></div></div>

    <div class="card fade-in">${cardHead('T', '监管强度地图', '各行业必备证照数量')}

      <div class="card-bd"><div class="bars" id="licenseRank"></div></div></div>

  </div>`;



  // I 毛利率 vs 净利率散点图

  (function() {

    const parsePct = (s) => { const m = String(s || '').match(/(\d+(?:\.\d+)?)/g); return (!m || !m.length) ? null : m.map(Number); };

    const pts = inds.map(ind => {

      const gm = parsePct(ind['毛利率区间']); const gn = parsePct(ind['净利率区间']);

      if (!gm || !gn) return null;

      return { x: gm[0], y: gn[0], name: ind['细分行业'], code: ind['行业编号'], gm, gn };

    }).filter(Boolean);

    if (!pts.length) { $('#scatterPP').innerHTML = '<p class="hint">暂无利润率数据</p>'; return; }

    const maxX = Math.max(...pts.map(p => p.x)) || 1, maxY = Math.max(...pts.map(p => p.y)) || 1;

    const dots = pts.map(p => {

      const color = p.x >= 20 || p.y >= 10 ? '#059669' : p.x >= 10 ? '#d97706' : '#dc2626';

      return `<div class="sdot" style="left:${(p.x/maxX*100).toFixed(1)}%;bottom:${(p.y/maxY*100).toFixed(1)}%;background:${color}" title="${esc(p.name)}：毛${p.gm[0]}%~${p.gm[1]||p.gm[0]}% 净${p.gn[0]}%~${p.gn[1]||p.gn[0]}%"></div>`;

    }).join('');

    $('#scatterPP').innerHTML = `<div class="scatter-axis-y">净利率%</div><div class="scatter-area">${dots}</div><div class="scatter-axis-x">毛利率% →</div>`;

  })();



  // J 旺淡季日历热力图

  (function() {

    const months = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

    const catMonths = {};

    for (const ind of inds) {

      const cat = ind['行业大类'] || '其他';

      if (!catMonths[cat]) catMonths[cat] = new Array(12).fill(0);

      const peak = String(ind['旺季月份'] || ''); const m = peak.match(/(\d+)/g);

      if (m) for (const mo of m) { const mi = parseInt(mo)-1; if (mi>=0 && mi<12) catMonths[cat][mi]++; }

    }

    const cats2 = Object.entries(catMonths).sort((a,b) => b[1].reduce((x,y)=>x+y,0) - a[1].reduce((x,y)=>x+y,0));

    const maxM = Math.max(1, ...cats2.map(x => Math.max(...x[1])));

    let h = '<table class="cal-tbl"><thead><tr><th>门类</th>' + months.map(m => `<th>${m}</th>`).join('') + '</tr></thead><tbody>';

    for (const [cat, arr] of cats2) {

      h += `<tr><td class="rowh">${esc(cat)}</td>` + arr.map(v => {

        const op = v === 0 ? '0' : (v / maxM * 0.9 + 0.1).toFixed(2);

        return `<td class="cal-c" style="background:rgba(37,99,235,${op})" title="${esc(cat)}: ${v}个行业">${v||''}</td>`;

      }).join('') + '</tr>';

    }

    h += '</tbody></table>';

    $('#calHeat').innerHTML = h;

  })();



  // M 政策驱动词频分析

  (function() {

    const kw = ['专项债','补贴','税收优惠','环保','数字化转型','新能源','乡村振兴','城市更新','保障性住房','技改','监管','审批','牌照','碳达峰','以旧换新','减税降费'];

    const freq = {};

    for (const ind of inds) { const txt = String(ind['政策与外部驱动'] || ''); for (const k of kw) { if (txt.includes(k)) freq[k] = (freq[k]||0) + 1; } }

    const sorted = Object.entries(freq).sort((a,b) => b[1]-a[1]);

    const mx = Math.max(1, ...sorted.map(x => x[1]));

    $('#policyFreq').innerHTML = sorted.map(([n,v]) => `<div class="bar-row green"><div class="bl">${esc(n)}</div><div class="bt"><div class="bf" style="width:${(v/mx*100).toFixed(1)}%"></div></div><div class="bv">${v} <small style="color:#94a3b8;font-weight:400">${(v/inds.length*100).toFixed(0)}%</small></div></div>`).join('');

  })();



  // T 监管强度地图

  (function() {

    const scored = inds.map(ind => {

      const lic = String(ind['必备证照资质'] || '');

      const count = (lic.match(/[、，]/g) || []).length + 1;

      const hasCert = /证|许可|资质|执照/.test(lic);

      return { name: ind['细分行业'], code: ind['行业编号'], count: hasCert ? count : 0 };

    }).filter(x => x.count > 0).sort((a,b) => b.count - a.count);

    const top = scored.slice(0, 25);

    const mx = Math.max(1, ...top.map(x => x.count));

    $('#licenseRank').innerHTML = `<div class="bars">${top.map(x => `<div class="bar-row ${x.count >= 5 ? 'red' : x.count >= 3 ? 'orange' : 'gold'}"><div class="bl">${esc(x.code)} ${esc(x.name)}</div><div class="bt"><div class="bf" style="width:${(x.count/mx*100).toFixed(1)}%"></div></div><div class="bv">${x.count}项</div></div>`).join('')}</div>`;

  })();

}



// ================================================================== 职业分析

function pageAnaJob(c) {

  const ctx = getAnalyticsCtx();

  const { inds, jobs, salaryStats, demandMap } = ctx;

  c.innerHTML = `

  <div class="ana-grid">

    <div class="card fade-in">${cardHead('G', '职业市场需求热度', '高/中/低三档需求分布')}

      <div class="card-bd"><div class="bars">

        ${Object.entries(demandMap).map(([n, v]) => `<div class="bar-row ${n === '高' ? 'red' : n === '中' ? 'gold' : 'green'}">

          <div class="bl">${n === '高' ? '需求旺盛' : n === '中' ? '需求稳定' : '需求一般'}</div>

          <div class="bt"><div class="bf" style="width:${(v / Math.max(1, salaryStats.length) * 100).toFixed(1)}%"></div></div>

          <div class="bv">${v} <small style="color:#94a3b8;font-weight:400">${(v / Math.max(1, salaryStats.length) * 100).toFixed(1)}%</small></div></div>`).join('')}

      </div></div></div>

    <div class="card fade-in">${cardHead('N', '职业交叉行业薪资矩阵', '同一职位在不同行业的薪资对比')}

      <div class="card-bd"><div class="tbl-wrap" id="crossJob"></div></div></div>

    <div class="card fade-in">${cardHead('O', '职业审核难度评估', '基于证据可查性和破绽数量评分')}

      <div class="card-bd"><div id="auditDiff"></div></div></div>

    <div class="card fade-in">${cardHead('U', '职业群组聚类', '按需求等级分组 · 薪资范围一目了然')}

      <div class="card-bd"><div id="jobCluster"></div>

        <div class="cluster-legend">

          <span><i style="background:#dc2626"></i>高需求</span>

          <span><i style="background:#059669"></i>中需求</span>

          <span><small style="color:#94a3b8">条形=薪资范围（最低~最高） · 圆点=中位数</small></span>

        </div></div></div>

  </div>`;



  // N 职业交叉行业薪资矩阵

  (function() {

    const jobIndMap = {};

    for (const j of jobs) {

      const jn = j['常见职位'];

      if (!jobIndMap[jn]) jobIndMap[jn] = [];

      const sk = Object.keys(DB.salary).find(k => k.endsWith('|' + jn));

      const sd = sk ? DB.salary[sk] : null;

      jobIndMap[jn].push({ code: j['行业编号'], industry: inds.find(i => i['行业编号']===j['行业编号'])?['细分行业']:j['行业编号'], salary: sd });

    }

    const crossJobs = Object.entries(jobIndMap).filter(([k,v]) => v.length > 1).sort((a,b) => b[1].length-a[1].length).slice(0, 15);

    if (!crossJobs.length) { $('#crossJob').innerHTML = '<p class="hint">暂无跨行业职业数据</p>'; return; }

    let h = '<table class="tbl compact"><thead><tr><th>职位</th><th>出现行业数</th><th>基准月薪范围</th><th>薪资差异</th><th>详情</th></tr></thead><tbody>';

    for (let idx = 0; idx < crossJobs.length; idx++) {

      const [jn, arr] = crossJobs[idx];

      const sals = arr.map(x => x.salary).filter(Boolean);

      if (!sals.length) continue;

      const mins = Math.min(...sals.map(s => s.monthly_min || s.monthly_median));
      const maxs = Math.max(...sals.map(s => s.monthly_max || s.monthly_median));
      const medianMin = Math.min(...sals.map(s => s.monthly_median));
      const medianMax = Math.max(...sals.map(s => s.monthly_median));

      const diff = maxs - mins;
      const diffPct = mins > 0 ? (diff/mins*100).toFixed(0) : 0;

      h += `<tr><td><b>${esc(jn)}</b></td><td>${arr.length}</td><td>${(mins/1000).toFixed(1)}k - ${(maxs/1000).toFixed(1)}k</td><td><span class="tag ${diffPct > 30 ? 'red' : diffPct > 15 ? 'gold' : 'green'}">+${diffPct}%</span></td>`;
      h += `<td><button class="btn xs" onclick="document.getElementById('cmpDetail_${idx}').style.display = (document.getElementById('cmpDetail_${idx}').style.display==='none'?'':'none')">展开</button></td></tr>`;

      h += `<tr id="cmpDetail_${idx}" style="display:none"><td colspan="5"><div style="padding:8px;background:#f9fafb;border-radius:6px">`;
      h += '<table class="tbl compact" style="font-size:12px"><thead><tr><th>行业</th><th>中位数</th><th>区间</th><th>购买力PPI</th><th>趋势</th></tr></thead><tbody>';
      for (const x of arr) {
        if (!x.salary) continue;
        const s = x.salary;
        const trend = s.trend || {};
        const last = trend['2025'] || trend['2024'] || {};
        const trendIcon = (last.monthly_median || 0) > s.monthly_median ? '↑' : '↓';
        h += `<tr><td>${esc(x.industry)}</td><td><b>${(s.monthly_median/1000).toFixed(1)}k</b></td><td>${(s.monthly_min/1000).toFixed(1)}-${(s.monthly_max/1000).toFixed(1)}k</td><td>${s.purchasing_power_index || '—'}</td><td>${trendIcon}</td></tr>`;
      }
      h += '</tbody></table>';
      h += '</div></td></tr>';

    }

    h += '</tbody></table>';

    h += '<p class="hint" style="margin-top:8px">点击"展开"查看该职位在各行业的薪资明细（含购买力指数和趋势）。</p>';

    $('#crossJob').innerHTML = h;

  })();



  // O 职业审核难度评估

  (function() {

    const indMap = new Map(inds.map(i => [i['行业编号'], i]));

    const scored = jobs.map(j => {

      const evidence = String(j['能查到哪些证据'] || '');

      const flaws = String(j['没干过的破绽'] || '');

      const eCount = (evidence.match(/[、，；,;]/g) || []).length + 1;

      const fCount = (flaws.match(/[、，；,;]/g) || []).length + 1;

      const score = Math.round(eCount * 10 + fCount * 8);

      const ind = indMap.get(j['行业编号']);

      const catName = ind ? ind['行业大类'] : j['行业编号'];

      return { jn: j['常见职位'], code: j['行业编号'], cat: catName, score, eCount, fCount, evidence, flaws };

    }).sort((a,b) => b.score - a.score);

    const seen = new Set(), unique = [];

    for (const s of scored) { if (seen.has(s.jn)) continue; seen.add(s.jn); unique.push(s); }

    const top = unique.slice(0, 20);

    const mx = Math.max(1, ...top.map(x => x.score));

    $('#auditDiff').innerHTML = `<div class="bars">${top.map(x => `<div class="bar-row ${x.score >= 40 ? 'green' : x.score >= 25 ? 'gold' : 'red'}"><div class="bl" title="${esc(x.cat)}">${esc(x.jn)}<small style="display:block;color:#94a3b8;font-size:10px;font-weight:400">${esc(x.cat)}</small></div><div class="bt"><div class="bf" style="width:${(x.score/mx*100).toFixed(1)}%"></div></div><div class="bv">${x.score}分 <small style="color:#94a3b8;font-weight:400">证据${x.eCount}·破绽${x.fCount}</small></div></div>`).join('')}</div>`;

  })();



  // U 职业群组聚类 - 双视图：合并视图 + 行业展开视图

  (function() {

    // 1. 准备原始数据（按行业展开）

    const allJobs = [];

    for (const [k, s] of Object.entries(DB.salary)) {

      if (!s || !s.monthly_median) continue;

      const name = k.split('|')[1] || k;

      const code = k.split('|')[0] || '';

      const ind = DB.industries ? DB.industries.find(i => i['行业编号'] === code) : null;

      const cat = ind ? ind['行业大类'] : code;

      allJobs.push({

        name, code, cat,

        min: s.monthly_min || s.monthly_median * 0.75,

        median: s.monthly_median,

        max: s.monthly_max || s.monthly_median * 1.35,

        demand: s.demand || '中'

      });

    }

    if (!allJobs.length) { $('#jobCluster').innerHTML = '<p class="hint">暂无数据</p>'; return; }



    // 2. 按职位名合并数据

    const jobMap = {};

    for (const j of allJobs) {

      if (!jobMap[j.name]) {

        jobMap[j.name] = {

          name: j.name, min: j.min, max: j.max,

          medians: [], items: [], demand: j.demand

        };

      }

      const m = jobMap[j.name];

      if (j.min < m.min) m.min = j.min;

      if (j.max > m.max) m.max = j.max;

      m.medians.push(j.median);

      m.items.push(j);

      if (j.demand === '高') m.demand = '高';

    }

    const merged = Object.values(jobMap).map(j => ({

      ...j,

      median: Math.round(j.medians.reduce((a,b) => a+b, 0) / j.medians.length),

      indCount: j.items.length,

    }));



    const demandOrder = ['高', '中', '低'];

    const demandColors = { '高': '#dc2626', '中': '#059669', '低': '#64748b' };



    // 3. 渲染函数：合并视图

    function renderMerged() {

      const groups = { '高': [], '中': [], '低': [] };

      for (const j of merged) { (groups[j.demand] || (groups[j.demand] = groups['中'])).push(j); }

      const allMax = Math.max(...merged.map(j => j.max), 1);

      let h = '';

      for (const d of demandOrder) {

        const jobs = groups[d] || [];

        if (!jobs.length) continue;

        jobs.sort((a, b) => b.median - a.median);

        const top = jobs.slice(0, 12);

        h += `<div class="cluster-group"><div class="cluster-label" style="border-left-color:${demandColors[d]}">${d}需求 <small style="color:#94a3b8;font-weight:400">${jobs.length} 个职位（合并去重）· 显示前${top.length}</small></div><div class="cluster-jobs">`;

        for (const j of top) {

          const leftPct = (j.min / allMax * 100).toFixed(1);

          const widthPct = Math.max(2, ((j.max - j.min) / allMax * 100)).toFixed(1);

          const medPct = (j.median / allMax * 100).toFixed(1);

          const cats = [...new Set(j.items.map(i => i.cat))];

          const catList = cats.slice(0, 2).join('、') + (cats.length > 2 ? '…' : '');

          const title = `${j.name}\n薪资范围: ${j.min}~${j.max}\n中位数: ${j.median}\n覆盖行业: ${j.indCount}个 (${catList})\n需求: ${j.demand}`;

          h += `<div class="cluster-job" title="${esc(title)}"><div class="cj-name">${esc(j.name)}<small class="cj-tag">${j.indCount}行业</small></div><div class="cj-bar"><div class="cj-range" style="left:${leftPct}%;width:${widthPct}%;background:${demandColors[d]}"></div><div class="cj-med" style="left:${medPct}%;border-color:${demandColors[d]}"></div></div><div class="cj-sal">${(j.median / 1000).toFixed(1)}k</div></div>`;

        }

        h += '</div></div>';

      }

      return h;

    }



    // 4. 渲染函数：行业展开视图（按职位名分组，展开显示各行业）

    function renderExpanded() {

      const groups = { '高': [], '中': [], '低': [] };

      for (const j of merged) { (groups[j.demand] || (groups[j.demand] = groups['中'])).push(j); }

      const allMax = Math.max(...allJobs.map(j => j.max), 1);

      let h = '';

      for (const d of demandOrder) {

        const jobs = groups[d] || [];

        if (!jobs.length) continue;

        jobs.sort((a, b) => b.median - a.median);

        const top = jobs.slice(0, 8);  // 展开视图显示更少的职位组，但每个组内有详情

        h += `<div class="cluster-group"><div class="cluster-label" style="border-left-color:${demandColors[d]}">${d}需求 <small style="color:#94a3b8;font-weight:400">${jobs.length} 个职位组 · 显示前${top.length}组（展开各行业）</small></div><div class="cluster-jobs">`;

        for (const j of top) {

          // 组标题行

          const leftPct = (j.min / allMax * 100).toFixed(1);

          const widthPct = Math.max(2, ((j.max - j.min) / allMax * 100)).toFixed(1);

          const medPct = (j.median / allMax * 100).toFixed(1);

          const title = `${j.name}（共${j.indCount}个行业）\n薪资范围: ${j.min}~${j.max}\n中位数: ${j.median}\n需求: ${j.demand}`;

          h += `<div class="cluster-job cj-group-head" title="${esc(title)}"><div class="cj-name"><b>${esc(j.name)}</b><small class="cj-tag">${j.indCount}行业</small></div><div class="cj-bar"><div class="cj-range" style="left:${leftPct}%;width:${widthPct}%;background:${demandColors[d]};opacity:.45"></div><div class="cj-med" style="left:${medPct}%;border-color:${demandColors[d]}"></div></div><div class="cj-sal"><b>${(j.median / 1000).toFixed(1)}k</b></div></div>`;

          // 组内各行职位（按薪资排序）

          const items = [...j.items].sort((a, b) => b.median - a.median);

          for (const it of items) {

            const lPct = (it.min / allMax * 100).toFixed(1);

            const wPct = Math.max(2, ((it.max - it.min) / allMax * 100)).toFixed(1);

            const mPct = (it.median / allMax * 100).toFixed(1);

            const itTitle = `${it.name} · ${it.cat}\n行业: ${it.code}\n薪资: ${it.min}~${it.max}\n中位数: ${it.median}\n需求: ${it.demand}`;

            h += `<div class="cluster-job cj-sub" title="${esc(itTitle)}"><div class="cj-name"><span class="cj-dot" style="background:${demandColors[d]}"></span>${esc(it.cat)}</div><div class="cj-bar"><div class="cj-range" style="left:${lPct}%;width:${wPct}%;background:${demandColors[d]};opacity:.6"></div><div class="cj-med sm" style="left:${mPct}%;border-color:${demandColors[d]}"></div></div><div class="cj-sal" style="color:#64748b">${(it.median / 1000).toFixed(1)}k</div></div>`;

          }

        }

        h += '</div></div>';

      }

      return h;

    }



    // 5. 初始渲染 + 视图切换

    let viewMode = 'merged'; // 视图模式：merged 合并视图 | expanded 行业展开视图

    function render() {

      const h = viewMode === 'merged' ? renderMerged() : renderExpanded();

      const toggleBtn = `<div class="cluster-toggle">

        <button class="ct-btn ${viewMode === 'merged' ? 'on' : ''}" data-view="merged">合并视图</button>

        <button class="ct-btn ${viewMode === 'expanded' ? 'on' : ''}" data-view="expanded">行业展开</button>

      </div>`;

      $('#jobCluster').innerHTML = toggleBtn + `<div class="job-cluster">${h}</div>`;

      $$('.ct-btn', $('#jobCluster')).forEach(btn => {

        btn.onclick = () => { viewMode = btn.dataset.view; render(); };

      });

    }

    render();

  })();

}



// ================================================================== 城市分析

function pageAnaCity(c) {

  const ctx = getAnalyticsCtx();

  const { cityRows } = ctx;

  c.innerHTML = `

  <div class="ana-grid">

    <div class="card fade-in">${cardHead('C', '城市风险分布', '各城市风险等级占比')}

      <div class="card-bd" id="cityRiskDist"></div></div>

    <div class="card fade-in">${cardHead('P', '城市薪资购买力排行', '各城市薪资系数 vs 实际购买力')}

      <div class="card-bd"><div class="bars" id="cityPP"></div></div></div>

  </div>`;



  // 城市风险分布（堆叠条形图）

  (function() {

    const el = $('#cityRiskDist'); if (!el) return;

    const totalMax = Math.max(1, ...cityRows.map(x => x[1].total));

    const lvColors = { 'A': '#059669', 'B': '#3b82f6', 'C': '#d97706', 'D': '#dc2626' };

    el.innerHTML = cityRows.map(([cn, m]) => {

      const pct = m.total / totalMax * 100;

      const tot = m.total;

      const bar = (val, color) => val > 0 ? `<div style="height:100%;width:${(val/tot*100)}%;background:${color}"></div>` : '';

      return `<div class="city-risk-row"><div class="crr-lbl">${esc(cn)}</div><div class="crr-bar"><div class="crr-fill" style="width:${pct}%">${bar(m.aLow, lvColors.A)}${bar(m.bLow, lvColors.B)}${bar(m.mid, lvColors.C)}${bar(m.high, lvColors.D)}</div></div><div class="crr-vals"><span style="color:#059669">A:${m.aLow}</span><span style="color:#3b82f6">B:${m.bLow}</span><span style="color:#d97706">C:${m.mid}</span><span style="color:#dc2626">D:${m.high}</span></div></div>`;

    }).join('') + `<div class="legend" style="margin-top:10px"><span><i style="background:#059669"></i>A 低风险</span><span><i style="background:#3b82f6"></i>B 中低</span><span><i style="background:#d97706"></i>C 中等</span><span><i style="background:#dc2626"></i>D 高风险</span></div>`;

  })();



  // P 城市薪资购买力排行

  (function() {

    const cf = DB.city_factors || {};

    const allSal = Object.values(DB.salary).filter(s => s && s.monthly_median);

    const avgBase = allSal.length ? Math.round(allSal.reduce((a,s) => a + s.monthly_median, 0) / allSal.length) : 7000;

    const entries = Object.entries(cf).map(([city, f]) => {

      const salF = f.salary_factor || f;

      const costF = f.cost_factor || 1;

      const nominal = Math.round(avgBase * salF);

      const purchasing = Math.round(nominal / costF);

      const ppRatio = (salF / costF).toFixed(2);

      return { city, salF, costF, nominal, purchasing, ppRatio };

    }).sort((a,b) => b.purchasing - a.purchasing);

    const mx = Math.max(1, ...entries.map(x => Math.max(x.nominal, x.purchasing)));

    $('#cityPP').innerHTML = entries.map(x => `

      <div class="bar-row ${x.ppRatio >= 1.2 ? 'green' : x.ppRatio >= 1.0 ? '' : 'gold'}">

        <div class="bl">${esc(x.city)}</div>

        <div class="bt">

          <div class="bf" style="width:${(x.nominal/mx*100).toFixed(1)}%;background:linear-gradient(90deg,#3b82f6,#2563eb);opacity:0.7" title="名义薪资"></div>

          <div class="bf" style="position:relative;width:${(x.purchasing/mx*100).toFixed(1)}%;background:linear-gradient(90deg,#10b981,#059669);margin-top:-100%;height:100%" title="购买力等值"></div>

        </div>

        <div class="bv">${(x.purchasing/1000).toFixed(1)}k <small style="color:#94a3b8">购买力×${x.ppRatio}</small></div>

      </div>

    `).join('') + `<div class="legend" style="margin-top:8px;font-size:12px;color:#64748b"><span><i style="background:#3b82f6;display:inline-block;width:12px;height:10px;border-radius:2px;vertical-align:middle"></i> 名义薪资</span> <span style="margin-left:12px"><i style="background:#10b981;display:inline-block;width:12px;height:10px;border-radius:2px;vertical-align:middle"></i> 购买力等值</span></div>`;

  })();

}



// ================================================================== 薪资分析

function pageAnaSalary(c) {

  const ctx = getAnalyticsCtx();

  const { inds, jobs, salaryStats, salaryBins, sMax } = ctx;

  c.innerHTML = `

  <div class="ana-grid">

    <div class="card fade-in">${cardHead('F', '职业薪资分布', `${salaryStats.length} 个职业的月薪中位数分布`)}

      <div class="card-bd"><div class="bars">

        ${Object.entries(salaryBins).map(([n, v]) => `<div class="bar-row ${n.includes('20k') || n.includes('12-20') ? 'green' : n.includes('8-12') ? '' : n.includes('5-8') ? 'gold' : n.includes('3-5') ? 'orange' : 'red'}"><div class="bl">${esc(n)}</div><div class="bt"><div class="bf" style="width:${(v / sMax * 100).toFixed(1)}%"></div></div><div class="bv">${v}</div></div>`).join('')}

      </div>

      <p class="hint" style="margin-top:10px">基于国家统计局行业基准薪资，含各城市调整系数</p>

      </div></div>

    <div class="card fade-in">${cardHead('N', '薪资增长趋势TOP10', '近7年年均增长率最高的职业')}
      <div class="card-bd"><div class="tbl-wrap" id="crossJob2"></div></div></div>

    <div class="card fade-in" style="grid-column:1/-1">${cardHead('🏙', '全城市薪资 vs 购买力对比', '20个城市的平均月薪与购买力等值')}
      <div class="card-bd"><div id="citySalaryPP"></div></div></div>

  </div>`;

  // 城市薪资 vs 购买力对比（全城市）
  (function() {
    const cf = DB.city_factors || {};
    const cities = DB.cities.map(c => c['城市名称'] || c['城市']).filter(Boolean);
    // 计算所有岗位的平均中位数
    const allMedians = Object.values(DB.salary).map(s => s.monthly_median || 0).filter(v => v > 0);
    const avgMedian = allMedians.length ? Math.round(allMedians.reduce((a,b) => a+b, 0) / allMedians.length) : 8000;

    const cityData = cities.map(cn => {
      const f = (cf[cn] && cf[cn].salary_factor) ? cf[cn].salary_factor : 1;
      const costF = (cf[cn] && cf[cn].cost_factor) ? cf[cn].cost_factor : 1;
      const nominal = Math.round(avgMedian * f);
      const pp = Math.round(nominal / costF);
      return { city: cn, nominal, pp, factor: f, costFactor: costF };
    }).sort((a, b) => b.pp - a.pp);

    const maxVal = Math.max(...cityData.map(d => Math.max(d.nominal, d.pp)));
    let h = '<div class="city-bars city-mode full-city" style="display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end;padding:8px 0">';
    cityData.forEach(d => {
      const nh = (d.nominal / maxVal * 100).toFixed(1);
      const ph = (d.pp / maxVal * 100).toFixed(1);
      h += `<div class="city-bar-group" style="flex:0 0 auto;min-width:72px;">
        <div class="city-bar-pair" style="display:flex;gap:3px;align-items:flex-end;height:180px;justify-content:center;">
          <div class="city-bar" title="${d.city}名义薪资: ${(d.nominal/1000).toFixed(1)}k" style="width:16px;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center">
            <div class="bar-fill" style="height:${nh}%;width:100%;background:linear-gradient(180deg,#60a5fa,#2563eb);border-radius:3px 3px 0 0"></div>
          </div>
          <div class="city-bar" title="${d.city}购买力: ${(d.pp/1000).toFixed(1)}k" style="width:16px;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center">
            <div class="bar-fill" style="height:${ph}%;width:100%;background:linear-gradient(180deg,#34d399,#059669);border-radius:3px 3px 0 0"></div>
          </div>
        </div>
        <div class="bar-lbl" style="text-align:center;font-size:11px;margin-top:6px;color:#475569;font-weight:500;">${d.city}</div>
        <div style="text-align:center;font-size:10px;color:#94a3b8;margin-top:2px;"><span style="color:#2563eb;">${(d.nominal/1000).toFixed(1)}k</span>·<span style="color:#059669;">${(d.pp/1000).toFixed(1)}k</span></div>
      </div>`;
    });
    h += '</div>';
    h += '<div class="city-bars-legend" style="margin-top:12px;font-size:12px;color:#6b7280">';
    h += '<span style="margin-right:16px"><i style="display:inline-block;width:12px;height:12px;background:#2563eb;margin-right:4px"></i>名义月薪（含城市系数）</span>';
    h += '<span><i style="display:inline-block;width:12px;height:12px;background:#059669;margin-right:4px"></i>购买力等值（扣除生活成本）</span>';
    h += '</div>';
    h += '<p class="hint" style="margin-top:8px">基于975个职业的平均月薪中位数，按各城市薪资系数调整后计算购买力等值。购买力 = 名义薪资 ÷ 生活成本系数。</p>';
    $('#citySalaryPP').innerHTML = h;
  })();



  // N 薪资增长趋势TOP10
  (function() {
    const growthList = [];
    for (const [k, s] of Object.entries(DB.salary)) {
      const trend = s.trend || {};
      const years = Object.keys(trend).sort();
      if (years.length < 4) continue;
      const earliest = trend[years[0]];
      const latest = trend[years[years.length - 1]];
      if (!earliest || !latest || !earliest.monthly_median || !latest.monthly_median) continue;
      const growth = ((latest.monthly_median - earliest.monthly_median) / earliest.monthly_median * 100).toFixed(1);
      const jobName = k.split('|')[1] || k;
      growthList.push({ key: k, job: jobName, growth: parseFloat(growth), median: s.monthly_median });
    }
    growthList.sort((a, b) => b.growth - a.growth);
    const top10 = growthList.slice(0, 10);
    if (!top10.length) { $('#crossJob2').innerHTML = '<p class="hint">暂无趋势数据</p>'; return; }
    const maxGrowth = Math.max(...top10.map(x => x.growth));
    let h = '<table class="tbl compact"><thead><tr><th>排名</th><th>职业</th><th>年均增长</th><th>当前中位数</th><th>增长趋势</th></tr></thead><tbody>';
    top10.forEach((x, i) => {
      const barWidth = (x.growth / maxGrowth * 100).toFixed(1);
      const color = x.growth > 30 ? '#10b981' : x.growth > 15 ? '#f59e0b' : '#6b7280';
      h += `<tr><td><b>${i+1}</b></td><td><b>${esc(x.job)}</b></td><td style="color:${color};font-weight:600">+${x.growth}%</td><td>${(x.median/1000).toFixed(1)}k</td><td><div style="background:${color};height:8px;width:${barWidth}%;border-radius:4px"></div></td></tr>`;
    });
    h += '</tbody></table>';
    h += '<p class="hint" style="margin-top:8px">基于2019-2025年（7年）薪资趋势数据，增长率 = (最新中位数 - 最早中位数) / 最早中位数 × 100%</p>';
    $('#crossJob2').innerHTML = h;
  })();

}



// ================================================================== 风险分析

function pageAnaRisk(c) {

  const ctx = getAnalyticsCtx();

  const { inds, risks, cities, t, lvMap, lvTotal, indRisk, topRisk, bestRisk } = ctx;

  c.innerHTML = `

  <div class="ana-grid">

    <div class="card fade-in">${cardHead('B', '全库风险层级分布', 'A 低 → D 高')}

      <div class="card-bd"><div class="bars">

        ${Object.entries(lvMap).sort((a, b) => b[1] - a[1]).map(([n, v]) => `<div class="bar-row ${/^[D]/.test(n) ? 'red' : /^C/.test(n) ? 'gold' : /^B/.test(n) ? '' : 'green'}"><div class="bl">${esc(n)}级</div><div class="bt"><div class="bf" style="width:${(v / lvTotal * 100).toFixed(1)}%"></div></div><div class="bv">${v} <small style="color:#94a3b8;font-weight:400">${(v / lvTotal * 100).toFixed(1)}%</small></div></div>`).join('')}

      </div></div></div>

    <div class="card fade-in">${cardHead('D', '行业风险热力矩阵', `${t.行业} 行业 × ${t.城市} 城市 · 点击跳转`)}

      <div class="card-bd"><div class="heat-wrap" id="heatWrap"></div>

        <div class="legend"><span><i class="hc-A"></i>A 低风险</span><span><i class="hc-B"></i>B 中低</span><span><i class="hc-C"></i>C 中等</span><span><i class="hc-D"></i>D 高风险</span></div>

      </div></div>

    <div class="card fade-in">${cardHead('E', '行业风险指数排行', '点击城市筛选，查看各城市TOP风险行业')}

      <div class="card-bd">

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
          <div class="btn-row">
            <button class="btn sm on" data-rk="high">风险最高 TOP 20</button>
            <button class="btn sm" data-rk="low">风险最低 TOP 20</button>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:12px;color:#6b7280;">城市筛选：</span>
            <select id="rankCitySel" class="q-input" style="max-width:140px;font-size:12px;padding:4px 8px;">
              <option value="all">全部城市（平均）</option>
              ${cities.map(ct => { const cn = ct['城市名称'] || ct['城市'] || String(ct); return `<option value="${esc(cn)}">${esc(cn)}</option>`; }).join('')}
            </select>
          </div>
        </div>

        <div id="rankBox"></div>

      </div></div>

    <div class="card fade-in">${cardHead('R', '风险-利润象限图', 'X=风险指数 Y=毛利率')}

      <div class="card-bd"><div class="scatter-plot quad" id="quadPlot"></div>

        <div class="scatter-legend"><span><i style="background:#dc2626"></i>高风险高利润</span><span><i style="background:#059669"></i>低风险高利润</span><span><i style="background:#d97706"></i>高风险低利润</span><span><i style="background:#64748b"></i>低风险低利润</span></div>

      </div></div>

  </div>`;



  // 热力矩阵

  (function() {

    const cityNames = cities.map(x => x['城市名称']);

    const riskByInd = new Map();

    for (const r of risks) { if (!riskByInd.has(r['行业编号'])) riskByInd.set(r['行业编号'], new Map()); riskByInd.get(r['行业编号']).set(r['城市'], r['风险层级']); }

    let h = '<table class="heat"><thead><tr><th style="left:0;z-index:4;background:#f8fafc">行业</th>' + cityNames.map(n => `<th>${esc(n)}</th>`).join('') + '</tr></thead><tbody>';

    for (const a of indRisk) {

      const m = riskByInd.get(a['行业编号']) || new Map();

      h += `<tr><td class="rowh" title="${esc(a['行业编号'] + ' ' + a['细分行业'])}">${esc(a['行业编号'])} ${esc(a['细分行业'])}</td>` + cityNames.map(cn => {

        const v = m.get(cn) || '';

        const nv = normLv(v);

        return `<td class="c ${heatClass(v)}" data-i="${esc(a['行业编号'])}" data-c="${esc(cn)}" title="${esc(a['行业编号'] + ' · ' + cn + '：' + nv)}">${esc(nv)}</td>`;

      }).join('') + '</tr>';

    }

    h += '</tbody></table>';

    $('#heatWrap').innerHTML = h;

    $$('#heatWrap td.c').forEach(td => {

      td.onclick = () => { S.dash.industry = td.dataset.i; S.dash.city = td.dataset.c; S.dash.ci = new Set([td.dataset.i]); S.dash.cj = new Set(); S.dash.cc = new Set([td.dataset.c]); S.dash.queried = true; go('dashboard'); };

    });

  })();



  // 排行
  let currentRankMode = 'high';
  let currentRankCity = 'all';

  const renderRank = (mode, city) => {
    currentRankMode = mode || currentRankMode;
    currentRankCity = city !== undefined ? city : currentRankCity;
    
    let list;
    if (currentRankCity === 'all') {
      list = currentRankMode === 'high' ? topRisk : bestRisk;
    } else {
      // 按指定城市过滤，使用该城市的风险等级计算指数
      const cityRisks = risks.filter(r => r['城市'] === currentRankCity);
      const cityIndRisk = [];
      for (let i = 0; i < inds.length; i++) {
        const ind = inds[i];
        const r = cityRisks.find(x => x['行业编号'] === ind['行业编号']);
        if (!r) continue;
        const lv = normLv(r['风险层级']) || 'C';
        const score = lv === 'A' ? 1 : lv === 'B' ? 2 : lv === 'C' ? 3 : 4;
        cityIndRisk.push({ ...ind, 风险指数: score, 最高风险城市: currentRankCity });
      }
      cityIndRisk.sort((a, b) => b.风险指数 - a.风险指数);
      list = currentRankMode === 'high' ? cityIndRisk.slice(0, 20) : cityIndRisk.slice(-20).reverse();
    }
    
    if (!list.length) {
      $('#rankBox').innerHTML = '<p class="hint" style="text-align:center;padding:20px;">该城市暂无行业风险数据</p>';
      return;
    }

    const mx = Math.max(...list.map(x => x.风险指数 || 0), 1);

    $('#rankBox').innerHTML = `<div class="bars">${list.map(x => `<div class="bar-row ${x.风险指数 >= 4 ? 'red' : x.风险指数 >= 3 ? 'orange' : x.风险指数 >= 2 ? 'gold' : 'green'}"><div class="bl" style="cursor:pointer" title="点击跳转看板">${esc(x['行业编号'])} ${esc(x['细分行业'])}</div><div class="bt"><div class="bf" style="width:${(x.风险指数 / mx * 100).toFixed(1)}%"></div></div><div class="bv">${x.风险指数} <small style="color:#94a3b8;font-weight:400">${esc(currentRankCity === 'all' ? (x['最高风险城市'] || '') : currentRankCity)}</small></div></div>`).join('')}</div>`;

    $$('#rankBox .bar-row .bl').forEach((el, i) => {

      el.onclick = () => { 
        S.dash.industry = list[i]['行业编号']; 
        S.dash.ci = new Set([list[i]['行业编号']]); 
        S.dash.cj = new Set(); 
        S.dash.cc = currentRankCity === 'all' ? new Set() : new Set([currentRankCity]); 
        S.dash.queried = true; 
        go('dashboard'); 
      };

    });

  };

  renderRank('high', 'all');

  $$('[data-rk]').forEach(b => { b.onclick = () => { $$('[data-rk]').forEach(x => x.classList.remove('on')); b.classList.add('on'); renderRank(b.dataset.rk); }; });
  
  // 城市筛选
  const rankCitySel = document.getElementById('rankCitySel');
  if (rankCitySel) {
    rankCitySel.onchange = () => {
      renderRank(currentRankMode, rankCitySel.value);
    };
  }



  // R 风险-利润象限图

  (function() {

    const parsePct2 = (s) => { const m = String(s||'').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[0]) : null; };

    let pts = indRisk.filter(x => {

      const ind = inds.find(i => i['行业编号'] === x['行业编号']);

      return ind && parsePct2(ind['毛利率区间']) != null;

    }).map(x => {

      const ind = inds.find(i => i['行业编号'] === x['行业编号']);

      return { 
        x: x.风险指数, 
        y: parsePct2(ind['毛利率区间']), 
        name: x['细分行业'], 
        code: x['行业编号'],
        cat: ind['行业大类'] || '其他'
      };

    });

    if (!pts.length) { $('#quadPlot').innerHTML = '<p class="hint">暂无数据</p>'; return; }

    // 计算象限统计
    function calcQuadStats(data) {
      const stats = { q1: 0, q2: 0, q3: 0, q4: 0 }; // q1=高风险高利润, q2=低风险高利润, q3=高风险低利润, q4=低风险低利润
      data.forEach(p => {
        const hiRisk = p.x >= 3, hiProf = p.y >= 15;
        if (hiRisk && hiProf) stats.q1++;
        else if (!hiRisk && hiProf) stats.q2++;
        else if (hiRisk && !hiProf) stats.q3++;
        else stats.q4++;
      });
      return stats;
    }

    function renderQuad(data) {
      const maxX = 5, maxY = Math.max(25, ...data.map(p => p.y));
      const stats = calcQuadStats(data);
      
      const dots = data.map(p => {
        const hiRisk = p.x >= 3, hiProf = p.y >= 15;
        const color = hiRisk && hiProf ? '#dc2626' : !hiRisk && hiProf ? '#059669' : hiRisk && !hiProf ? '#d97706' : '#64748b';
        return `<div class="sdot quad-dot" data-code="${esc(p.code)}" data-name="${esc(p.name)}" style="left:${(p.x/maxX*100).toFixed(1)}%;bottom:${(p.y/maxY*100).toFixed(1)}%;background:${color}" title="${esc(p.name)}：风险${p.x} 毛利率${p.y}%"></div>`;
      }).join('');

      const vLineLeft = (3 / maxX * 100).toFixed(1) + '%';
      const hLineBottom = (15 / maxY * 100).toFixed(1) + '%';

      return `
        <div style="position:relative;">
          <!-- 象限统计标签 -->
          <div class="quad-stat q1">Q1 高风险高利润: <b>${stats.q1}</b></div>
          <div class="quad-stat q2">Q2 低风险高利润: <b>${stats.q2}</b></div>
          <div class="quad-stat q3">Q3 高风险低利润: <b>${stats.q3}</b></div>
          <div class="quad-stat q4">Q4 低风险低利润: <b>${stats.q4}</b></div>
          <div class="scatter-area quad">
            ${dots}
            <div class="quad-line-v" style="left:${vLineLeft}"></div>
            <div class="quad-line-h" style="bottom:${hLineBottom}"></div>
          </div>
        </div>
      `;
    }

    $('#quadPlot').innerHTML = renderQuad(pts);

    // 点击散点跳转到看板
    $$('.quad-dot', $('#quadPlot')).forEach(dot => {
      dot.style.cursor = 'pointer';
      dot.onclick = () => {
        S.dash.industry = dot.dataset.name;
        S.dash.ci = new Set([dot.dataset.code]);
        S.dash.queried = true;
        addRecent('industry', dot.dataset.code, dot.dataset.name, {});
        go('dashboard');
      };
    });

  })();

}



// ================================================================== 资金分析

function pageAnaFinance(c) {

  const ctx = getAnalyticsCtx();

  const { inds } = ctx;

  c.innerHTML = `

  <div class="ana-grid">

    <div class="card fade-in">${cardHead('K', '季节性资金缺口时间轴', '按月份排列资金需求高峰')}

      <div class="card-bd"><div id="fundGap"></div></div></div>

    <div class="card fade-in">${cardHead('L', '典型融资用途分类统计', '融资用途关键词频次')}

      <div class="card-bd"><div class="bars" id="fundUse"></div></div></div>

    <div class="card fade-in">${cardHead('S', '资金需求紧迫度排行', '综合融资+资金缺口+淡旺季评分')}

      <div class="card-bd"><div class="bars" id="fundRank"></div></div></div>

  </div>`;



  // K 季节性资金缺口时间轴

  (function() {

    // 扩展月份映射：支持季度、节日、季节等关键词
    const monthMap = {
      'Q1': [1,2,3], '一季度': [1,2,3], '年初': [1,2], '春节前': [1], '春节后': [2,3], '春节': [1,2],
      'Q2': [4,5,6], '二季度': [4,5,6], '春耕': [3,4], '春投': [3,4],
      'Q3': [7,8,9], '三季度': [7,8,9], '暑期': [7,8], '夏季': [5,6,7,8], '开学季': [8,9], '暑运': [7,8],
      'Q4': [10,11,12], '四季度': [10,11,12], '年底': [11,12], '年终': [11,12], '冬季': [10,11,12], '春运': [1,2],
      '中秋': [8,9], '国庆': [9,10], '圣诞': [12], '元旦': [1], '情人节': [2],
      '大促': [10,11], '双11': [10,11], '618': [5,6], '车展': [9,10],
      '备货': [10,11], '旺季': [7,8,9,10], '淡季': [2,3,4],
      '复工': [3], '招聘': [2,3], '扩产': [3,4], '检修': [9,10]
    };

    const gaps = [];

    for (const ind of inds) {

      const txt = String(ind['季节性资金缺口高峰'] || '');

      if (!txt || txt === '—' || txt.includes('通用职能岗')) continue;

      const found = new Set();

      // 匹配季度和关键词
      for (const [k, months] of Object.entries(monthMap)) {
        if (txt.includes(k)) { months.forEach(m => found.add(m)); }
      }

      // 匹配 "X月" 格式
      const mMatch = txt.match(/(\d+)月/g);
      if (mMatch) for (const mm of mMatch) { const mi = parseInt(mm); if (mi>=1 && mi<=12) found.add(mi); }

      // 匹配 "X-Y月" 范围
      const rangeMatch = txt.match(/(\d+)-(\d+)月/g);
      if (rangeMatch) {
        for (const r of rangeMatch) {
          const parts = r.match(/(\d+)-(\d+)月/);
          if (parts) {
            const a = parseInt(parts[1]), b = parseInt(parts[2]);
            for (let i = Math.min(a,b); i <= Math.max(a,b); i++) found.add(i);
          }
        }
      }

      const months = [...found].sort((a,b)=>a-b);
      if (months.length === 0) continue;

      gaps.push({ name: ind['细分行业'], code: ind['行业编号'], months, text: txt });

    }

    if (!gaps.length) { $('#fundGap').innerHTML = '<p class="hint">暂无资金缺口数据</p>'; return; }

    const months2 = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

    let h = '<table class="cal-tbl"><thead><tr><th>行业</th>' + months2.map(m => `<th>${m}</th>`).join('') + '</tr></thead><tbody>';

    for (const g of gaps.slice(0, 40)) {

      h += `<tr><td class="rowh" title="${esc(g.text)}">${esc(g.name)}</td>`;

      for (let i = 1; i <= 12; i++) { const on = g.months.includes(i); h += `<td class="cal-c" style="background:${on ? 'rgba(220,38,38,0.7)' : ''}">${on ? '⚠' : ''}</td>`; }

      h += '</tr>';

    }

    h += '</tbody></table>';

    $('#fundGap').innerHTML = h;

  })();



  // L 融资用途分类统计

  (function() {

    const kw = ['保证金','垫资','工资','采购','进货','设备','租金','装修','扩建','周转','还贷','税款','社保','工程款','材料'];

    const freq = {};

    for (const ind of inds) { const txt = String(ind['典型融资用途'] || ''); for (const k of kw) { if (txt.includes(k)) freq[k] = (freq[k]||0) + 1; } }

    const sorted = Object.entries(freq).sort((a,b) => b[1]-a[1]);

    const mx = Math.max(1, ...sorted.map(x => x[1]));

    $('#fundUse').innerHTML = sorted.map(([n,v]) => `<div class="bar-row"><div class="bl">${esc(n)}</div><div class="bt"><div class="bf" style="width:${(v/mx*100).toFixed(1)}%"></div></div><div class="bv">${v} <small style="color:#94a3b8;font-weight:400">${(v/inds.length*100).toFixed(0)}%</small></div></div>`).join('');

  })();



  // S 资金需求紧迫度排行

  (function() {

    const scored = inds.map(ind => {

      const fund = String(ind['典型融资用途'] || ''); const gap = String(ind['季节性资金缺口高峰'] || '');

      let score = 0;

      ['保证金','垫资','工资','设备','周转'].forEach(k => { if (fund.includes(k)) score += 3; });

      if (gap.includes('春节')) score += 5;

      if (gap.includes('年初')) score += 3;

      if (gap.includes('最大') || gap.includes('高峰')) score += 2;

      const peak = String(ind['旺季月份']||'');

      if (peak.includes('3') || peak.includes('9')) score += 2;

      return { name: ind['细分行业'], code: ind['行业编号'], score };

    }).filter(x => x.score > 0).sort((a,b) => b.score - a.score);

    const top = scored.slice(0, 20);

    const mx = Math.max(1, ...top.map(x => x.score));

    $('#fundRank').innerHTML = `<div class="bars">${top.map(x => `<div class="bar-row ${x.score >= 15 ? 'red' : x.score >= 10 ? 'orange' : 'gold'}"><div class="bl" style="cursor:pointer">${esc(x.code)} ${esc(x.name)}</div><div class="bt"><div class="bf" style="width:${(x.score/mx*100).toFixed(1)}%"></div></div><div class="bv">${x.score}分</div></div>`).join('')}</div>`;

    $$('#fundRank .bar-row .bl').forEach((el, i) => {

      el.onclick = () => { S.dash.industry = top[i].code; S.dash.ci = new Set([top[i].code]); S.dash.cj = new Set(); S.dash.cc = new Set(); S.dash.queried = true; go('dashboard'); };

    });

  })();

}



// ================================================================== 管理页

function dataTablePage(c, cfg) {

  const allData = applyEdits(cfg.name, DB[cfg.name]);

  const st = { page: 1, size: cfg.size || 50, q: '', total: 0 };



  c.innerHTML = `

    <div class="card">

      ${cardHead(cfg.no || '', cfg.title, cfg.sub || '')}

      <div class="card-bd">

        <div class="toolbar">

          <input type="text" id="fQ" placeholder="关键词全文检索…">

          <span class="sp"></span>

          <span class="hint" id="cnt"></span>

          <button class="btn" id="bExp">⬇ 导出本页数据</button>

        </div>

        <div class="tbl-wrap" id="tw"></div>

        <div class="pager" id="pg"></div>

      </div>

    </div>`;



  function reload() {

    let rows = allData;

    if (st.q) {

      const kw = st.q.toLowerCase();

      rows = rows.filter(r => Object.values(r).some(v => String(v || '').toLowerCase().includes(kw)));

    }

    st.total = rows.length;

    const start = (st.page - 1) * st.size;

    const pageRows = rows.slice(start, start + st.size);

    $('#cnt').textContent = `共 ${st.total} 条`;

    renderRows(pageRows);

    renderPager();

  }



  function renderRows(rows) {

    if (!rows.length) { $('#tw').innerHTML = '<div class="empty"><span class="big">🗂</span>没有匹配的记录</div>'; return; }

    const cols = cfg.columns;

    $('#tw').innerHTML = `<table class="tbl"><thead><tr>${cols.map(x => `<th>${esc(x.t)}</th>`).join('')}</tr></thead>

      <tbody>${rows.map(r => `<tr>${cols.map(x => {

        const v = x.f ? x.f(r) : r[x.k];

        if (x.cls === 'lv') return `<td><span class="lv ${lvClass(v)}">${esc(v || '—')}</span></td>`;

        if (x.cls === 'code') return `<td class="code">${esc(v || '')}</td>`;

        return `<td class="${x.wrap === false ? '' : 'wrap'}">${x.raw ? v : nl2br(v)}</td>`;

      }).join('')}</tr>`).join('')}</tbody></table>`;

  }



  function renderPager() {

    const pages = Math.max(1, Math.ceil(st.total / st.size));

    $('#pg').innerHTML = `

      <button class="btn sm" id="pPrev" ${st.page <= 1 ? 'disabled' : ''}>上一页</button>

      <span>第 ${st.page} / ${pages} 页（${st.total} 条）</span>

      <button class="btn sm" id="pNext" ${st.page >= pages ? 'disabled' : ''}>下一页</button>

      <select id="pSize">${[20, 50, 100, 200].map(n => `<option value="${n}"${n === st.size ? ' selected' : ''}>${n} 条/页</option>`).join('')}</select>`;

    $('#pPrev').onclick = () => { st.page--; reload(); };

    $('#pNext').onclick = () => { st.page++; reload(); };

    $('#pSize').onchange = (e) => { st.size = Number(e.target.value); st.page = 1; reload(); };

  }



  $('#fQ').oninput = debounce((e) => { st.q = e.target.value.trim(); st.page = 1; reload(); }, 280);

  $('#bExp').onclick = () => {

    const data = JSON.stringify(allData, null, 2);

    const blob = new Blob([data], { type: 'application/json' });

    const a = document.createElement('a');

    a.href = URL.createObjectURL(blob);

    a.download = `xwk_${cfg.name}_${Date.now()}.json`;

    a.click();

    setTimeout(() => URL.revokeObjectURL(a.href), 4000);

    toast('已开始下载', a.download);

  };

  reload();

}



function pageIndustries(c) {

  dataTablePage(c, {

    name: 'industries', no: '01', title: '行业管理（行业档案 + 前景利润淡旺季）',

    sub: `共 ${DB.meta.industry_count} 个细分行业`,

    columns: [

      { t: '编号', k: '行业编号', cls: 'code', wrap: false },

      { t: '门类', k: '行业大类', wrap: false },

      { t: '细分行业', k: '细分行业', wrap: false },

      { t: '典型经营主体形态', k: '典型经营主体形态' },

      { t: '必备证照资质', k: '必备证照资质' },

      { t: '常见经营规模', k: '常见经营规模' },

      { t: '前景趋势判断', k: '前景趋势判断' },

      { t: '毛利率', k: '毛利率区间', wrap: false },

      { t: '净利率', k: '净利率区间', wrap: false },

    ],

    size: 50,

  });

}



function pageJobs(c) {

  dataTablePage(c, {

    name: 'jobs', no: '04', title: '职业管理（在职客户岗位核实）',

    sub: `共 ${DB.meta.job_count} 条岗位明细`,

    columns: [

      { t: '编号', k: '行业编号', cls: 'code', wrap: false },

      { t: '常见职位', k: '常见职位', wrap: false, f: (r) => `<b>${esc(r['常见职位'])}</b>`, raw: true },

      { t: '岗位每天干什么', k: '这个岗位每天干什么' },

      { t: '审核时怎么问', k: '审核时怎么问' },

      { t: '能查到哪些证据', k: '能查到哪些证据' },

      { t: '真干过的人怎么答', k: '真干过的人怎么答' },

      { t: '没干过的破绽', k: '没干过的破绽' },

      { t: '审批要点', k: '审批要点' },

    ],

    size: 50,

  });

}



function pageCityRisks(c) {
  const cities = DB.cities.map(x => x['城市名称'] || x['城市']);
  let currentCity = 'all';
  
  function render() {
    let filteredData = DB.city_risks;
    if (currentCity !== 'all') {
      filteredData = DB.city_risks.filter(r => r['城市'] === currentCity);
    }
    
    const count = filteredData.length;
    
    let html = `<div class="card">
      <div class="card-hd">
        <h3>🏙️ 城市风控（行业 × 城市 风险分级）</h3>
        <p class="dim">共 ${count} 条记录${currentCity !== 'all' ? ' · ' + currentCity : ''}</p>
      </div>
      <div class="card-bd">`;
    
    // 城市筛选按钮组
    html += '<div class="city-risk-filter">';
    html += `<button class="city-risk-btn ${currentCity === 'all' ? 'active' : ''}" data-city="all">全部（${DB.city_risks.length}）</button>`;
    cities.forEach(ct => {
      const ctCount = DB.city_risks.filter(r => r['城市'] === ct).length;
      html += `<button class="city-risk-btn ${currentCity === ct ? 'active' : ''}" data-city="${esc(ct)}">${esc(ct)}（${ctCount}）</button>`;
    });
    html += '</div>';
    
    // 风险层级统计
    if (currentCity !== 'all') {
      const cityData = filteredData;
      const a = cityData.filter(r => r['风险层级'] === 'A').length;
      const b = cityData.filter(r => r['风险层级'] === 'B').length;
      const c2 = cityData.filter(r => r['风险层级'] === 'C').length;
      const d = cityData.filter(r => r['风险层级'] === 'D').length;
      const total = cityData.length || 1;
      html += `<div class="city-risk-stats">
        <div class="stat-item"><div class="stat-val" style="color:#10b981;">${a}</div><div class="stat-lbl">A级（${(a/total*100).toFixed(0)}%）</div></div>
        <div class="stat-item"><div class="stat-val" style="color:#f59e0b;">${b}</div><div class="stat-lbl">B级（${(b/total*100).toFixed(0)}%）</div></div>
        <div class="stat-item"><div class="stat-val" style="color:#f97316;">${c2}</div><div class="stat-lbl">C级（${(c2/total*100).toFixed(0)}%）</div></div>
        <div class="stat-item"><div class="stat-val" style="color:#ef4444;">${d}</div><div class="stat-lbl">D级（${(d/total*100).toFixed(0)}%）</div></div>
      </div>`;
    }
    
    // 表格
    html += '<div class="tbl-wrap"><table class="tbl"><thead><tr>';
    html += '<th style="width:70px;">编号</th><th style="width:80px;">城市</th><th style="width:60px;">风险层级</th><th>定级依据与尽调要点</th>';
    html += '</tr></thead><tbody>';
    
    filteredData.slice(0, 100).forEach(r => {
      const lv = r['风险层级'] || '—';
      const lvColor = lv === 'A' ? '#dcfce7' : lv === 'B' ? '#fef3c7' : lv === 'C' ? '#ffedd5' : '#fee2e2';
      const lvText = lv === 'A' ? '#166534' : lv === 'B' ? '#92400e' : lv === 'C' ? '#9a3412' : '#991b1b';
      html += `<tr>
        <td class="code">${esc(r['行业编号'] || '')}</td>
        <td>${esc(r['城市'] || '')}</td>
        <td><span style="background:${lvColor};color:${lvText};padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;">${lv}</span></td>
        <td style="font-size:12px;color:#475569;line-height:1.6;">${esc(r['依据与尽调要点'] || '—')}</td>
      </tr>`;
    });
    
    html += '</tbody></table></div>';
    
    if (filteredData.length > 100) {
      html += `<p class="hint" style="margin-top:8px;">仅显示前 100 条，共 ${filteredData.length} 条。请使用搜索功能精确查找。</p>`;
    }
    
    html += '</div></div>';
    c.innerHTML = html;
    
    // 绑定按钮事件
    $$('.city-risk-btn', c).forEach(btn => {
      btn.onclick = () => {
        currentCity = btn.dataset.city;
        render();
      };
    });
  }
  
  render();
}



function pageModes(c) {

  dataTablePage(c, {

    name: 'modes', no: '02', title: '经营模式详解',

    sub: `共 ${DB.meta.mode_count} 条模式`,

    columns: [

      { t: '编号', k: '行业编号', cls: 'code', wrap: false },

      { t: '细分模式', k: '细分模式', wrap: false },

      { t: '运作方式', k: '运作方式' },

      { t: '盈利逻辑', k: '盈利逻辑' },

      { t: '上下游与结算回款', k: '上下游与结算回款方式' },

      { t: '成本结构', k: '成本结构' },

      { t: '资金需求特点与周期', k: '资金需求特点与周期' },

      { t: '授信关注要点', k: '授信关注要点' },

    ],

    size: 50,

  });

}



// ================================================================== 全局搜索

function pageSearch(c) {

  c.innerHTML = `

    <div class="card">${cardHead('🔍', '全局搜索', '跨行业/职业/经营模式/城市风险/城市 五类数据')}

      <div class="card-bd">

        <div class="toolbar">

          <input type="text" id="gsQ" placeholder="输入关键词，如：挂靠、社保、光伏贷、重庆…" style="flex:1;min-width:280px">

          <button class="btn green" id="gsBtn">搜索</button>

        </div>

        <div id="gsRes"><div class="empty"><span class="big">🔍</span>输入关键词开始检索<br><small>支持按行话、证件名、风险点、城市名等任意字段全文匹配</small></div></div>

      </div></div>`;

  const run = () => {

    const q = $('#gsQ').value.trim().toLowerCase();

    if (!q) return;

    $('#gsRes').innerHTML = '<div class="loading"><span class="spin"></span>检索中…</div>';



    const inds = applyEdits('industries', DB.industries);

    const jobs = applyEdits('jobs', DB.jobs);

    const modes = applyEdits('modes', DB.modes);

    const risks = applyEdits('city_risks', DB.city_risks);



    const match = (obj, fields) => fields.some(f => String(obj[f] || '').toLowerCase().includes(q));

    const groups = [

      ['industries', '🏢 行业档案', inds, ['行业编号', '行业大类', '细分行业', '典型经营主体形态', '必备证照资质', '常见经营规模', '订单与客户来源', '典型融资用途', '前景趋势判断', '毛利率区间', '净利率区间', '旺季月份', '淡季月份', '季节性资金缺口高峰', '主要经营风险', '政策与外部驱动', '职业标签串']],

      ['jobs', '👥 职业核实', jobs, ['行业编号', '常见职位', '这个岗位每天干什么', '审核时怎么问', '能查到哪些证据', '真干过的人怎么答', '没干过的破绽', '审批要点']],

      ['modes', '🧩 经营模式', modes, ['行业编号', '细分模式', '运作方式', '盈利逻辑', '上下游与结算回款方式', '成本结构', '资金需求特点与周期', '授信关注要点']],

      ['city_risks', '🏙 城市风险', risks, ['行业编号', '城市', '风险层级', '依据与尽调要点']],

    ];



    let total = 0, h = '';

    for (const [k, title, data, fields] of groups) {

      const results = data.filter(r => match(r, fields)).slice(0, 40);

      if (!results.length) continue;

      total += results.length;

      h += `<div class="sr-group"><div class="gt">${esc(title)}<span class="c">${results.length}</span></div>

        ${results.map(x => {

          const key = keyOf(k, x);

          const titleField = k === 'industries' ? x['细分行业'] : k === 'jobs' ? x['常见职位'] : k === 'modes' ? x['细分模式'] : x['城市'];

          const subField = k === 'industries' ? x['行业大类'] : k === 'jobs' ? x['行业编号'] : k === 'modes' ? x['行业编号'] : x['行业编号'];

          const hitFields = fields.filter(f => String(x[f] || '').toLowerCase().includes(q));

          return `<div class="sr-item" data-k="${esc(key)}" data-type="${k}">

            <div class="t">${hlText(titleField, q)}</div>

            <div class="s">${esc(subField || '')}</div>

            <div class="hf">${hitFields.map(f => `<span class="tag gray">${esc(lb(f))}</span>`).join('')}</div>

          </div>`;

        }).join('')}</div>`;

    }



    $('#gsRes').innerHTML = total

      ? `<p class="hint" style="margin-bottom:11px">关键词「<b>${esc(q)}</b>」共命中 <b>${total}</b> 条，点击可跳转到看板定位。</p>${h}`

      : `<div class="empty"><span class="big">🈳</span>没有找到包含「${esc(q)}」的内容</div>`;



    $$('#gsRes .sr-item').forEach(el => {

      el.onclick = () => {

        const k = el.dataset.k;

        const parts = k.split('|');

        if (el.dataset.type === 'city_risks') {

          S.dash.industry = parts[0] || ''; S.dash.city = parts[1] || '';
          S.dash.ci = new Set(parts[0] ? [parts[0]] : []); S.dash.cj = new Set(); S.dash.cc = new Set(parts[1] ? [parts[1]] : []);
          S.dash.queried = true;

        } else {

          S.dash.industry = parts[0]; S.dash.ci = new Set([parts[0]]); S.dash.cj = new Set(); S.dash.cc = new Set(); S.dash.queried = true;

        }

        go('dashboard');

      };

    });

  };

  $('#gsBtn').onclick = run;

  $('#gsQ').onkeydown = (e) => { if (e.key === 'Enter') run(); };

  $('#gsQ').focus();

}



function hlText(text, kw) {

  const t = esc(text);

  if (!kw) return t;

  const k = esc(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  try { return t.replace(new RegExp('(' + k + ')', 'gi'), '<span class="hl">$1</span>'); }

  catch { return t; }

}



// ================================================================== 数据更新中心

function pageDataUpdate(c) {

  const m = DB.meta;

  const jobCount = DB.jobs.length;

  const salaryCount = Object.keys(DB.salary).length;

  const lastUpdate = m.version + ' · ' + m.last_updated;



  c.innerHTML = `

    <div class="update-grid fade-in">

      <div class="update-card">

        <div class="uh"><span class="ui">📊</span><span class="ut">行业数据</span></div>

        <div class="uv">${m.industry_count}</div>

        <div class="ud">细分行业覆盖<br>含前景、利润、淡旺季等19个维度</div>

      </div>

      <div class="update-card">

        <div class="uh"><span class="ui">👥</span><span class="ut">职业数据</span></div>

        <div class="uv">${jobCount}</div>

        <div class="ud">岗位核实明细<br>含审核话术、破绽识别、审批要点</div>

      </div>

      <div class="update-card">

        <div class="uh"><span class="ui">💰</span><span class="ut">薪资数据</span></div>

        <div class="uv">${salaryCount}</div>

        <div class="ud">2020-2026年7年趋势<br>含月薪范围、年薪、增长率、需求热度</div>

      </div>

      <div class="update-card">

        <div class="uh"><span class="ui">🏙</span><span class="ut">城市风控</span></div>

        <div class="uv">${m.city_risk_count}</div>

        <div class="ud">${m.city_count}城市×${m.industry_count}行业<br>含风险层级与尽调要点</div>

      </div>

    </div>



    <div class="card fade-in">${cardHead('📋', '数据版本与说明', '当前数据版本和来源声明')}

      <div class="card-bd">

        <p class="hint" style="margin-bottom:14px">本知识库为离线快照版本，数据更新需由管理员手动导入。</p>

        <div style="padding:12px 14px;background:#f0fdf4;border-radius:8px;border-left:3px solid #059669">

          <p class="hint" style="margin:0">当前数据版本：<b>${lastUpdate}</b><br>

          数据来源：招聘平台公开薪资数据 + 行业研究报告（毛利率/净利率/淡旺季） + 城市统计公报 + 信贷风控经验数据<br>

          评分模型：5维度加权评分（景气度25%+盈利能力25%+稳定性20%+政策环境20%+竞争格局10%），含门控惩罚与百分位等级分配<br>

          数据性质：仅供参考，不构成授信决策唯一依据</p>

        </div>

      </div>

    </div>



    <div class="card fade-in">${cardHead('💰', '薪资数据来源说明', '当前薪资数据的获取渠道和计算方法')}

      <div class="card-bd">

        <table class="tbl">

          <thead><tr><th>数据源</th><th>来源说明</th><th>用途</th><th>更新频率</th></tr></thead>

          <tbody>

            <tr><td>招聘平台</td><td>2025年各行业岗位薪资公开数据</td><td>行业基准薪资</td><td>季度</td></tr>

            <tr><td>行业研究报告</td><td>各行业毛利率、净利率、淡旺季数据</td><td>行业经营特征</td><td>年度</td></tr>

            <tr><td>城市公开数据</td><td>各城市GDP、人均可支配收入、产业结构</td><td>城市薪资系数</td><td>年度</td></tr>

            <tr><td>风控经验数据</td><td>信贷审批实践中的行业风险判断</td><td>风险评分参考</td><td>不定期</td></tr>

          </tbody>

        </table>

        <div style="margin-top:12px;padding:12px 14px;background:#f0fdf4;border-radius:8px;border-left:3px solid #059669">

          <p class="hint" style="margin:0"><b>计算方法</b>：行业基准薪资 × 职位倍数 = 基准月薪；基准月薪 × 城市系数 = 城市薪资；按行业年增长率推算2020-2026年趋势。<br>

          <b>数据特点</b>：各行业增长率不同（+1.9%~+10.3%），各城市系数不同（北京1.85 vs 重庆0.94），体现真实差异。</p>

        </div>

      </div>

    </div>



    <div class="card fade-in">${cardHead('🏙', '城市风险数据来源说明', m.version + ' · ' + m.city_risk_count + '条风控数据的评估方法论')}

      <div class="card-bd">

        <table class="tbl">

          <thead><tr><th>评估维度</th><th>数据来源</th><th>权重</th><th>说明</th></tr></thead>

          <tbody>

            <tr><td>区域经济基础</td><td>各城市公开GDP、人均可支配收入数据</td><td>25%</td><td>经济基本面决定行业整体风险水平</td></tr>

            <tr><td>产业结构匹配度</td><td>各城市产业规划与主导产业公开信息</td><td>25%</td><td>当地主导产业风险更低，弱势产业风险更高</td></tr>

            <tr><td>政策环境</td><td>各地十四五规划、产业政策导向</td><td>20%</td><td>政策支持行业风险等级相应下调</td></tr>

            <tr><td>行业发展周期</td><td>行业研究报告、信贷风控经验数据</td><td>20%</td><td>成长期行业风险低，衰退期行业风险高</td></tr>

            <tr><td>区域信用环境</td><td>公开区域信贷质量参考数据</td><td>10%</td><td>当地整体信用环境参考</td></tr>

          </tbody>

        </table>

        <div style="margin-top:12px;padding:12px 14px;background:#eff6ff;border-radius:8px;border-left:3px solid #2563eb">

          <p class="hint" style="margin:0"><b>评估方法</b>：采用五维加权评分模型，综合得分0-100分，对应A/B/C/D四个风险等级（A: 低风险，B: 中低风险，C: 中等风险，D: 高风险）。<br>

          <b>数据规模</b>：${m.city_count}个城市 × ${m.industry_count}个细分行业 = ${m.city_risk_count}条城市风控记录，每条含风险层级、风险评分、行业优势、风险点、风控建议、尽调要点等10个字段。<br>

          <b>使用提示</b>：风险等级为信贷审批提供参考依据，实际决策需结合客户经营状况、财务数据、担保条件等综合判断。</p>

        </div>

      </div>

    </div>



    <div class="card fade-in">${cardHead('📋', '数据维度总览', '当前知识库包含的全部数据维度')}

      <div class="card-bd">

        <table class="tbl">

          <thead><tr><th>数据集</th><th>记录数</th><th>维度</th><th>更新频率</th></tr></thead>

          <tbody>

            <tr><td>行业档案</td><td>${m.industry_count}</td><td>19个字段（含门类、形态、证照、规模、前景、毛利率、净利率、淡旺季、成本结构等）</td><td>不定期</td></tr>

            <tr><td>经营模式</td><td>${m.mode_count}</td><td>12个字段（运作方式、盈利逻辑、成本结构、上下游结算回款等）</td><td>不定期</td></tr>

            <tr><td>职业核实</td><td>${jobCount}</td><td>12个字段（岗位内容、审核话术、破绽识别、审批要点等）</td><td>不定期</td></tr>

            <tr><td>城市风控</td><td>${m.city_risk_count}</td><td>10个字段（风险层级、评分、优势、风险点、风控建议、尽调要点等）</td><td>不定期</td></tr>

            <tr><td>薪资趋势</td><td>${salaryCount}</td><td>7年趋势（2020-2026月薪/年薪/增长率/需求）</td><td>不定期</td></tr>

            <tr><td>城市信息</td><td>${m.city_count}</td><td>2个字段（城市名称、定位标签）</td><td>年度</td></tr>

          </tbody>

        </table>

      </div>

    </div>

    <div class="card fade-in">${cardHead('📊', '授信评分卡说明', '行业差异化授信评估方法')}

      <div class="card-bd">

        <table class="tbl">

          <thead><tr><th>评估维度</th><th>权重</th><th>评分依据</th><th>说明</th></tr></thead>

          <tbody>

            <tr><td>行业景气度</td><td>25%</td><td>前景趋势关键词+毛利率+研发投入比综合评估</td><td>爆发期/高速增长期得分高，衰退期/萎缩期得分低</td></tr>

            <tr><td>盈利能力</td><td>25%</td><td>毛利率区间(60%)+净利率区间(40%)+人力成本修正</td><td>毛利率越高得分越高，分段映射避免极端集中</td></tr>

            <tr><td>经营稳定性</td><td>20%</td><td>旺季月份+行业特性+毛利率波动+前景关键词</td><td>旺季4-7个月最稳定，稳定性高的行业类别加分，毛利率波动大扣分</td></tr>

            <tr><td>政策环境</td><td>20%</td><td>政策关键词+行业大类修正+前景趋势</td><td>政策支持行业加分，强监管/限制行业减分</td></tr>

            <tr><td>竞争格局</td><td>10%</td><td>行业壁垒分类+成本结构+毛利率推断</td><td>高壁垒行业（军工/能源）高分，红海行业（零售/服务）低分</td></tr>

          </tbody>

        </table>

        <div style="margin-top:12px;padding:12px 14px;background:#f0fdf4;border-radius:8px;border-left:3px solid #059669">

          <p class="hint" style="margin:0"><b>评分等级</b>：采用百分位分配机制，按全行业综合得分排名划分5个等级——A级（约前15%）、B级（约15-40%）、C级（约40-85%）、D级（约85-95%）、E级（约后5%），避免极端集中。<br>

          <b>评分修正</b>：含门控惩罚（任一维度低于25分扣4分）、一致性奖励（全维度≥65分加4分）、方差惩罚（标准差>18扣2分），防止偏科行业虚高。<br>

          <b>授信标准</b>：基础额度 A级50万 → E级5万逐级递减；利率 A级4.5%-6% → E级18%+逐级上升；期限 A级最长3年 → E级不建议授信。<br>

          <b>使用提示</b>：评分结果为行业基准参考，实际授信需结合借款人资质、担保条件等综合判断。</p>

        </div>

      </div>

    </div>

    <div class="card fade-in">${cardHead('🧮', '额度计算器说明', '小微贷款额度测算方法')}

      <div class="card-bd">

        <div style="padding:12px 14px;background:#eff6ff;border-radius:8px;border-left:3px solid #2563eb;margin-bottom:12px">

          <p class="hint" style="margin:0;line-height:1.8">

          <b>核心公式</b>：授信额度 = 月收入 × 收入倍数 × 行业系数 × 城市系数 × 担保系数<br>

          <b>收入倍数</b>：普通岗位 8-12倍，核心岗位 12-18倍，高收入岗位 15-25倍<br>

          <b>行业系数</b>：A 级 1.2 / B 级 1.0 / C 级 0.8 / D 级 0.6 / E 级 0.4<br>

          <b>城市系数</b>：一线城市 1.2 / 新一线 1.1 / 二线 1.0 / 三线 0.85 / 四线及以下 0.7<br>

          <b>担保系数</b>：信用 1.0 / 保证 1.2 / 抵押 1.5 / 抵押+保证 1.8</p>

        </div>

        <p class="hint" style="margin:0">额度计算器提供初步测算参考，最终授信额度以实际审批结果为准。</p>

      </div>

    </div>

    <div class="card fade-in">${cardHead('⚠', '免责声明', '使用须知')}

      <div class="card-bd">

        <div style="padding:12px 14px;background:#fef3c7;border-radius:8px;border-left:3px solid #d97706">

          <p class="hint" style="margin:0;line-height:1.8">

          1. 本知识库数据为离线快照版本，非实时更新，数据可能存在时效性偏差。<br>

          2. 行业风险评分基于公开数据和风控经验模型，仅供参考，不构成授信决策唯一依据。<br>

          3. 实际信贷决策需结合客户实地尽调、财务报表、流水验证、担保条件等综合判断。<br>

          4. 薪资数据来源于招聘平台公开信息，不等同于企业实际发放薪资。<br>

          5. 风险层级A/B/C/D为相对参考值，不同机构的风险偏好不同，请结合本机构风控政策使用。<br>

          6. 本知识库仅限授权人员内部使用，禁止外传或用于商业用途。</p>

        </div>

      </div>

    </div>

  `;

}



// ================================================================== 页面注册



// ================================================================== 收藏夹页面

function pageFavorites(c) {

  c.innerHTML = '<div class="card"><div class="card-hd"><h3>⭐ 我的收藏</h3></div><div class="card-bd" id="favBody"></div></div>';

  const body = $('#favBody');

  const favs = S.favorites;

  let html = '';

  

  // 收藏的行业

  const favInds = DB.industries.filter(i => favs.industries.includes(i['行业编号']));

  html += '<div class="sec-h">🏢 收藏的行业 (' + favInds.length + ')</div>';

  if (favInds.length) {

    html += '<div class="fav-list">';

    for (const ind of favInds) {

      html += '<div class="fav-item"><div class="fi-main"><span class="code">' + esc(ind['行业编号']) + '</span> ' + esc(ind['细分行业']) + ' <span class="dim">(' + esc(ind['行业大类'] || '') + ')</span></div>' +

        '<div class="fi-act"><button class="btn xs" data-action="view-ind" data-code="' + esc(ind['行业编号']) + '">查看</button>' +

        '<button class="btn xs red" data-action="remove-fav" data-type="industries" data-key="' + esc(ind['行业编号']) + '">移除</button></div></div>';

    }

    html += '</div>';

  } else {

    html += '<div class="empty-sm">暂无收藏的行业，在数据看板中点击⭐按钮收藏</div>';

  }

  

  // 收藏的职位

  const favJobs = DB.jobs.filter(j => favs.jobs.includes(j['行业编号'] + '|' + j['常见职位']));

  html += '<div class="sec-h" style="margin-top:20px">👥 收藏的职位 (' + favJobs.length + ')</div>';

  if (favJobs.length) {

    html += '<div class="fav-list">';

    for (const job of favJobs) {

      const ind = DB.industries.find(i => i['行业编号'] === job['行业编号']);

      html += '<div class="fav-item"><div class="fi-main">' + esc(job['常见职位']) + ' <span class="dim">(' + esc(ind ? ind['细分行业'] : job['行业编号']) + ')</span></div>' +

        '<div class="fi-act"><button class="btn xs" data-action="view-job" data-code="' + esc(job['行业编号']) + '" data-job="' + esc(job['常见职位']) + '">查看</button>' +

        '<button class="btn xs red" data-action="remove-fav" data-type="jobs" data-key="' + esc(job['行业编号'] + '|' + job['常见职位']) + '">移除</button></div></div>';

    }

    html += '</div>';

  } else {

    html += '<div class="empty-sm">暂无收藏的职位</div>';

  }

  

  // 收藏的城市

  const favCities = DB.cities.filter(c2 => favs.cities.includes(c2['城市名称']));

  html += '<div class="sec-h" style="margin-top:20px">🏙 收藏的城市 (' + favCities.length + ')</div>';

  if (favCities.length) {

    html += '<div class="fav-list">';

    for (const ct of favCities) {

      html += '<div class="fav-item"><div class="fi-main">' + esc(ct['城市名称']) + ' <span class="dim">(' + esc(ct['定位标签'] || '') + ')</span></div>' +

        '<div class="fi-act"><button class="btn xs red" data-action="remove-fav" data-type="cities" data-key="' + esc(ct['城市名称']) + '">移除</button></div></div>';

    }

    html += '</div>';

  } else {

    html += '<div class="empty-sm">暂无收藏的城市</div>';

  }

  

  body.innerHTML = html;

  body.querySelectorAll('[data-action]').forEach(el => {
    el.onclick = () => {
      const action = el.dataset.action;
      if (action === 'view-ind') {
        goIndustryDetail(el.dataset.code);
      } else if (action === 'view-job') {
        goJobDetail(el.dataset.code, el.dataset.job);
      } else if (action === 'remove-fav') {
        removeFav(el.dataset.type, el.dataset.key);
      }
    };
  });
}

function removeFav(type, key) {

  const arr = S.favorites[type] || [];

  const idx = arr.indexOf(key);

  if (idx >= 0) arr.splice(idx, 1);

  localStorage.setItem('xwk_favs_v4', JSON.stringify(S.favorites));

  toast('已移除', key);

  if (S.page === 'favorites') pageFavorites($('#content'));

  renderNav();

}

function goIndustryDetail(code) {

  S.dash.ci = new Set([code]);

  S.dash.queried = true;

  go('dashboard');

}

function goJobDetail(code, job) {

  S.dash.ci = new Set([code]);

  S.dash.cj = new Set([job]);

  S.dash.queried = true;

  go('dashboard');

}


// ================================================================== 最近浏览页面

function pageRecent(c) {
  const typeNames = { industry: '行业', job: '岗位', city: '城市', page: '页面' };
  const typeColors = { industry: '#3b82f6', job: '#10b981', city: '#f59e0b', page: '#8b5cf6' };
  const typeIco = { industry: '🏭', job: '💼', city: '🏙️', page: '📄' };

  let html = `<div class="card">
    <div class="card-hd">
      <div><h3>🕐 最近浏览</h3><p class="dim">最近查看的 ${S.recent.length} 条记录，最多保留20条</p></div>
      ${S.recent.length > 0 ? '<button class="btn btn-ghost" id="clearRecentBtn">清空记录</button>' : ''}
    </div>
    <div class="card-bd">`;

  if (S.recent.length === 0) {
    html += `<div class="empty">
      <div style="font-size:48px;margin-bottom:16px;">📭</div>
      <h3>暂无浏览记录</h3>
      <p class="dim">查看行业、岗位、城市后会自动记录在这里</p>
    </div>`;
  } else {
    html += '<div class="recent-list">';
    S.recent.forEach((item, idx) => {
      const timeStr = formatTimeAgo(item.time);
      const color = typeColors[item.type] || '#94a3b8';
      html += `<div class="recent-item" data-idx="${idx}">
        <div class="recent-ico" style="background:${color}20;">${typeIco[item.type] || '📌'}</div>
        <div class="recent-info">
          <div class="recent-name">${esc(item.name)}</div>
          <div class="recent-meta">
            <span class="recent-type-tag" style="background:${color}15;color:${color};">${typeNames[item.type] || '其他'}</span>
            ${timeStr}
          </div>
        </div>
        <div class="recent-arrow">›</div>
      </div>`;
    });
    html += '</div>';
  }

  html += '</div></div>';
  c.innerHTML = html;

  // 绑定事件
  $$('.recent-item', c).forEach(el => {
    el.onclick = () => {
      const idx = parseInt(el.dataset.idx);
      goRecent(S.recent[idx]);
    };
  });

  const clearBtn = $('#clearRecentBtn', c);
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (confirm('确定要清空所有浏览记录吗？')) {
        clearRecent();
        pageRecent(c);
      }
    };
  }
}

function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}


// ================================================================== 行业对比矩阵页面

function pageIndCompare(c) {
  const industries = S.indCompare.map(code => DB.industries.find(i => i['行业编号'] === code)).filter(Boolean);
  
  let html = `<div class="card">
    <div class="card-hd ind-cmp-header">
      <div>
        <h3>📊 行业对比矩阵</h3>
        <p class="dim">选择2-4个行业进行全方位对比分析，${industries.length}/4</p>
      </div>
      <div class="ind-cmp-actions">
        <button class="btn" id="addIndCmpBtn">+ 添加行业</button>
        ${industries.length > 0 ? '<button class="btn btn-ghost" id="clearIndCmpBtn">清空</button>' : ''}
      </div>
    </div>
    <div class="card-bd">`;

  if (industries.length === 0) {
    html += `<div class="empty">
      <div style="font-size:48px;margin-bottom:16px;">📊</div>
      <h3>暂无对比行业</h3>
      <p class="dim">在行业总览页点击"加入对比"，或点击上方按钮添加</p>
      <button class="btn btn-primary" onclick="go('ind-overview')">去行业总览</button>
    </div>`;
  } else if (industries.length === 1) {
    html += `<div class="empty">
      <h3>请再添加至少1个行业</h3>
      <p class="dim">至少需要2个行业才能进行对比</p>
    </div>`;
  } else {
    // 对比维度
    const compareItems = [
      { key: '行业大类', label: '行业大类', type: 'text' },
      { key: '经营形态', label: '经营形态', type: 'text' },
      { key: '毛利率区间', label: '毛利率区间', type: 'highlight' },
      { key: '净利率区间', label: '净利率区间', type: 'text' },
      { key: '主要成本构成', label: '成本结构', type: 'text' },
      { key: '旺季月份', label: '旺季月份', type: 'text' },
      { key: '季节性资金缺口高峰', label: '资金缺口期', type: 'text' },
      { key: '政策与外部驱动', label: '政策环境', type: 'text' },
      { key: '主要经营风险', label: '主要风险', type: 'risk' },
      { key: '核心预警指标', label: '预警指标', type: 'text' },
    ];

    // 计算各行业的平均风险评分
    const riskScores = {};
    industries.forEach(ind => {
      const risks = DB.city_risks.filter(r => r['行业编号'] === ind['行业编号']);
      if (risks.length) {
        const avg = risks.reduce((s, r) => s + (r['风险评分'] || 0), 0) / risks.length;
        riskScores[ind['行业编号']] = Math.round(avg);
      } else {
        riskScores[ind['行业编号']] = '—';
      }
    });

    // 计算岗位数量
    const jobCounts = {};
    industries.forEach(ind => {
      jobCounts[ind['行业编号']] = DB.jobs.filter(j => j['行业编号'] === ind['行业编号']).length;
    });

    html += '<div style="overflow-x:auto;"><table class="tbl ind-cmp-table" style="min-width:700px;">';
    
    // 表头
    html += '<thead><tr><th style="width:140px;background:#f8fafc;position:sticky;left:0;z-index:2;">对比维度</th>';
    industries.forEach(ind => {
      html += `<th style="text-align:center;min-width:160px;">
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
          <div style="font-weight:600;font-size:14px;">${esc(ind['细分行业'])}</div>
          <div style="font-size:11px;color:#94a3b8;">${esc(ind['行业编号'])}</div>
          <button class="btn btn-xs btn-ghost" data-remove="${esc(ind['行业编号'])}" style="font-size:11px;padding:2px 8px;margin-top:4px;">移除</button>
        </div>
      </th>`;
    });
    html += '</tr></thead><tbody>';

    // 风险评分（特殊行）
    html += '<tr style="background:#fef3c7;">';
    html += '<td style="font-weight:600;background:#f8fafc;position:sticky;left:0;z-index:2;">⚠️ 平均风险评分</td>';
    industries.forEach(ind => {
      const score = riskScores[ind['行业编号']];
      const color = score === '—' ? '#94a3b8' : score <= 30 ? '#10b981' : score <= 50 ? '#f59e0b' : score <= 70 ? '#f97316' : '#ef4444';
      html += `<td style="text-align:center;"><span class="ind-cmp-score" style="background:${color};">${score}</span></td>`;
    });
    html += '</tr>';

    // 岗位数量（特殊行）
    html += '<tr>';
    html += '<td style="font-weight:600;background:#f8fafc;position:sticky;left:0;z-index:2;">💼 岗位数量</td>';
    industries.forEach(ind => {
      html += `<td style="text-align:center;"><b>${jobCounts[ind['行业编号']]}</b> 个</td>`;
    });
    html += '</tr>';

    // 生命周期（特殊行）
    html += '<tr>';
    html += '<td style="font-weight:600;background:#f8fafc;position:sticky;left:0;z-index:2;">📈 生命周期</td>';
    industries.forEach(ind => {
      const tag = ind.cycleTag || '成长期';
      const colorMap = { '爆发期': '#ec4899', '成长期': '#10b981', '政策驱动期': '#3b82f6', '稳定期': '#6b7280', '成熟期': '#f59e0b', '衰退期': '#ef4444' };
      html += `<td style="text-align:center;"><span class="ind-cmp-tag" style="background:${colorMap[tag] || '#6b7280'}15;color:${colorMap[tag] || '#6b7280'};">${tag}</span></td>`;
    });
    html += '</tr>';

    // 常规对比项
    compareItems.forEach(item => {
      html += '<tr>';
      html += `<td style="font-weight:600;background:#f8fafc;position:sticky;left:0;z-index:2;">${item.label}</td>`;
      industries.forEach(ind => {
        const val = ind[item.key] || '—';
        let cellContent = '';
        if (item.type === 'highlight') {
          cellContent = `<span class="ind-cmp-highlight">${esc(val)}</span>`;
        } else if (item.type === 'risk') {
          cellContent = `<span class="ind-cmp-risk">${esc(val)}</span>`;
        } else {
          cellContent = esc(val);
        }
        html += `<td style="text-align:center;font-size:12px;line-height:1.6;">${cellContent}</td>`;
      });
      html += '</tr>';
    });

    html += '</tbody></table></div>';

    // 对比结论
    const sortedByRisk = industries.slice().sort((a, b) => (riskScores[a['行业编号']] || 0) - (riskScores[b['行业编号']] || 0));
    const lowestRisk = sortedByRisk[0];
    const highestRisk = sortedByRisk[sortedByRisk.length - 1];
    
    html += `<div class="ind-cmp-conclusion">
      <h4>📋 对比结论</h4>
      <ul>
        <li><b>风险最低：</b>${esc(lowestRisk['细分行业'])}（平均评分 ${riskScores[lowestRisk['行业编号']]}）</li>
        <li><b>风险最高：</b>${esc(highestRisk['细分行业'])}（平均评分 ${riskScores[highestRisk['行业编号']]}）</li>
        <li><b>岗位最丰富：</b>${industries.reduce((a, b) => jobCounts[a['行业编号']] > jobCounts[b['行业编号']] ? a : b)['细分行业']}（${Math.max(...Object.values(jobCounts))} 个岗位）</li>
        <li><b>建议：</b>优先关注低风险+高毛利行业，高风险行业需增加增信措施</li>
      </ul>
    </div>`;
  }

  html += '</div></div>';
  c.innerHTML = html;

  // 绑定事件
  const addBtn = $('#addIndCmpBtn', c);
  if (addBtn) {
    addBtn.onclick = () => {
      // 打开行业选择弹窗
      showIndustrySelector();
    };
  }

  const clearBtn = $('#clearIndCmpBtn', c);
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (confirm('确定清空所有对比行业？')) {
        S.indCompare = [];
        localStorage.setItem('xwk_indcmp_v4', '[]');
        renderNav();
        pageIndCompare(c);
      }
    };
  }

  $$('[data-remove]', c).forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const code = btn.dataset.remove;
      S.indCompare = S.indCompare.filter(x => x !== code);
      localStorage.setItem('xwk_indcmp_v4', JSON.stringify(S.indCompare));
      renderNav();
      pageIndCompare(c);
    };
  });
}

// 添加行业到对比
function toggleIndCompare(code, name) {
  const idx = S.indCompare.indexOf(code);
  if (idx >= 0) {
    S.indCompare.splice(idx, 1);
    toast('已移除', name + ' 已从对比中移除', 'info');
  } else {
    if (S.indCompare.length >= 4) {
      toast('最多4个', '行业对比最多同时对比4个行业', 'warn');
      return false;
    }
    S.indCompare.push(code);
    toast('已添加', name + ' 已加入对比', 'ok');
  }
  localStorage.setItem('xwk_indcmp_v4', JSON.stringify(S.indCompare));
  renderNav();
  return true;
}

// 行业选择器弹窗
function showIndustrySelector() {
  const cats = {};
  DB.industries.forEach(i => {
    const cat = i['行业大类'] || '其他';
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(i);
  });

  let html = '<div style="max-height:60vh;overflow-y:auto;">';
  for (const [cat, inds] of Object.entries(cats)) {
    html += `<div style="margin-bottom:16px;">
      <div style="font-weight:600;color:#374151;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #e5e7eb;">${esc(cat)}（${inds.length}个）</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">`;
    inds.forEach(ind => {
      const checked = S.indCompare.includes(ind['行业编号']);
      html += `<label style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:${checked ? '#dbeafe' : '#f8fafc'};border-radius:6px;cursor:pointer;font-size:13px;">
        <input type="checkbox" ${checked ? 'checked' : ''} data-code="${esc(ind['行业编号'])}" data-name="${esc(ind['细分行业'])}" style="accent-color:#3b82f6;">
        <span>${esc(ind['细分行业'])}</span>
      </label>`;
    });
    html += '</div></div>';
  }
  html += '</div>';

  modal('选择对比行业（最多4个）',
    html + '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">' +
    '<button class="btn btn-ghost" id="indCmpCancel">取消</button>' +
    '<button class="btn btn-primary" id="indCmpOk">确定</button>' +
    '</div>'
  );
  
  setTimeout(() => {
    const cancelBtn = document.getElementById('indCmpCancel');
    const okBtn = document.getElementById('indCmpOk');
    if (cancelBtn) cancelBtn.onclick = () => closeModal();
    if (okBtn) okBtn.onclick = () => {
      const checks = $$('#modalBody input[type=checkbox]:checked');
      const selected = Array.from(checks).map(c => c.dataset.code);
      if (selected.length > 4) {
        toast('最多4个', '请选择不超过4个行业', 'warn');
        return;
      }
      S.indCompare = selected;
      localStorage.setItem('xwk_indcmp_v4', JSON.stringify(selected));
      renderNav();
      closeModal();
      if (S.page === 'ind-compare') go('ind-compare');
      toast('已更新', `已选择 ${selected.length} 个行业进行对比`, 'ok');
    };
  }, 10);
}


// ================================================================== 职位对比页面

function pageCompare(c) {

  c.innerHTML = '<div class="card"><div class="card-hd"><h3>⚖️ 职位对比</h3><p class="dim">最多同时对比3个职位</p></div><div class="card-bd" id="cmpBody"></div></div>';

  const body = $('#cmpBody');

  const cmpKeys = S.compare;

  

  if (!cmpKeys.length) {

    body.innerHTML = `
      <div class="empty" style="padding:40px 20px;">
        <div style="font-size:48px;margin-bottom:16px;">⚖️</div>
        <div style="font-size:16px;font-weight:600;color:#0f172a;margin-bottom:8px;">还没有添加对比职位</div>
        <div style="font-size:13px;color:#64748b;margin-bottom:20px;line-height:1.8;">
          最多可同时对比 3 个职位<br>
          使用方法：进入 <b>电核助手</b> → 搜索岗位 → 点击「加入对比」按钮
        </div>
        <button class="btn btn-primary" id="cmpGoInterview">🎙 去电核助手找职位</button>
      </div>`;
    
    setTimeout(() => {
      const btn = document.getElementById('cmpGoInterview');
      if (btn) btn.onclick = () => go('interview');
    }, 10);

    return;

  }

  

  // 获取职位数据

  const cmpJobs = cmpKeys.map(k => {

    const [code, name] = k.split('|');

    return DB.jobs.find(j => j['行业编号'] === code && j['常见职位'] === name);

  }).filter(Boolean);

  

  if (!cmpJobs.length) {

    body.innerHTML = '<div class="empty">对比数据失效，请重新添加</div>';

    return;

  }

  

  // 构建对比表格

  const city = DB.cities[0] ? DB.cities[0]['城市名称'] : '上海';

  let html = '<div class="cmp-table"><table><thead><tr><th>对比项</th>';

  for (const j of cmpJobs) {

    const ind = DB.industries.find(i => i['行业编号'] === j['行业编号']);

    html += '<th><div class="cmp-th-name">' + esc(j['常见职位']) + '</div><div class="cmp-th-sub">' + esc(ind ? ind['细分行业'] : j['行业编号']) + '</div>' +

      '<button class="btn xs red" data-action="remove-cmp" data-key="' + esc(j['行业编号'] + '|' + j['常见职位']) + '">移除</button></th>';

  }

  html += '</tr></thead><tbody>';

  

  const rows = [

    ['所属行业', j => { const ind = DB.industries.find(i => i['行业编号'] === j['行业编号']); return ind ? ind['细分行业'] : j['行业编号']; }],

    ['岗位内容', j => j['这个岗位每天干什么'] || '—'],

    ['审核要点', j => j['审批要点'] || '—'],

    ['入门门槛', j => {

      const n = j['常见职位'];

      if (/总监|首席|总经理|总裁|CEO|高级|资深|专家/.test(n)) return '🔴 高门槛（需多年经验）';

      if (/经理|主管|架构师/.test(n)) return '🟠 中高门槛（需管理/技术经验）';

      if (/工程师|设计师|专员|分析师/.test(n)) return '🟡 中等门槛（需专业技能）';

      return '🟢 低门槛（易上手）';

    }],

    ['薪资水平', j => {

      const sal = DB.salary[j['行业编号'] + '|' + j['常见职位']];

      if (sal && sal.city_salaries && sal.city_salaries[city]) {

        const s = sal.city_salaries[city];

        return '💰 ' + (s.monthly_min/1000).toFixed(1) + '-' + (s.monthly_max/1000).toFixed(1) + 'k /月<br><span class="dim">中位数 ' + (s.monthly_median/1000).toFixed(1) + 'k</span>';

      }

      return '—';

    }],

    ['薪资趋势', j => {

      const sal = DB.salary[j['行业编号'] + '|' + j['常见职位']];

      return sal && sal.trend && typeof sal.trend === 'object'

      ? Object.keys(sal.trend).sort().slice(-1)[0] + '年: ' + (sal.trend[Object.keys(sal.trend).sort().slice(-1)[0]].growth_rate || '—')

      : sal && sal.trend ? sal.trend : '—';

    }],

    ['需求程度', j => {

      const sal = DB.salary[j['行业编号'] + '|' + j['常见职位']];

      const d = sal ? sal.demand : '—';

      const map = {'高': '🔥 高需求', '中高': '⭐ 中高需求', '中等': '📊 需求稳定'};

      return map[d] || d;

    }],

    ['常见破绽', j => j['没干过的破绽'] || '—'],

  ];

  

  for (const [label, fn] of rows) {

    html += '<tr><td class="cmp-label">' + label + '</td>';

    for (const j of cmpJobs) {

      html += '<td>' + nl2br(fn(j)) + '</td>';

    }

    html += '</tr>';

  }

  

  html += '</tbody></table></div>';

  html += '<div style="margin-top:16px;text-align:center"><button class="btn" data-action="clear-cmp">清空对比</button></div>';

  

  body.innerHTML = html;

  body.querySelectorAll('[data-action]').forEach(el => {
    el.onclick = () => {
      const action = el.dataset.action;
      if (action === 'remove-cmp') {
        removeCmp(el.dataset.key);
      } else if (action === 'clear-cmp') {
        clearCmp();
      }
    };
  });
}

function removeCmp(key) {

  const idx = S.compare.indexOf(key);

  if (idx >= 0) S.compare.splice(idx, 1);

  localStorage.setItem('xwk_cmp_v4', JSON.stringify(S.compare));

  if (S.page === 'compare') pageCompare($('#content'));

  renderNav();

}

function clearCmp() {

  S.compare = [];

  localStorage.setItem('xwk_cmp_v4', '[]');

  if (S.page === 'compare') pageCompare($('#content'));

  renderNav();

}





// ================================================================== PDF专业报告导出

function generatePdfReport(industries, jobs, cities, allJobs, allRisks) {

  var today = new Date().toLocaleDateString('zh-CN');
  var indCount = industries.length;
  var jobCount = jobs.length;
  var cityCount = cities.length;

  var filteredRisks = allRisks.filter(function(r) {
    return industries.some(function(i) { return i['行业编号'] === r['行业编号']; }) && (!cities.length || cities.includes(r['城市']));
  });

  var riskStats = { A: 0, B: 0, C: 0, D: 0 };
  filteredRisks.forEach(function(r) { if (riskStats[r['风险层级']] !== undefined) riskStats[r['风险层级']]++; });

  var avgSalary = 0, salCount = 0;
  jobs.forEach(function(j) {
    var sk = j['行业编号'] + '|' + j['常见职位'];
    var sd = DB.salary[sk];
    if (sd && sd.monthly_median) { avgSalary += sd.monthly_median; salCount++; }
  });
  avgSalary = salCount > 0 ? Math.round(avgSalary / salCount) : 0;

  var modes = applyEdits('modes', DB.modes);

  var esc2 = function(s) { if (!s) return '-'; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };

  var lvColors = { A: '#059669', B: '#3b82f6', C: '#d97706', D: '#dc2626' };
  var lvBg = { A: '#d1fae5', B: '#dbeafe', C: '#fef3c7', D: '#fee2e2' };
  var lvText = { A: '低风险', B: '中低风险', C: '中等风险', D: '高风险' };

  // 每个行业的详细卡片
  var indCardsHtml = industries.slice(0, 15).map(function(ind) {
    var indModes = modes.filter(function(m) { return m['行业编号'] === ind['行业编号']; });
    var indRisks = filteredRisks.filter(function(r) { return r['行业编号'] === ind['行业编号']; });
    var indJobs = jobs.filter(function(j) { return j['行业编号'] === ind['行业编号']; });
    var riskLv = indRisks.length > 0 ? indRisks[0]['风险层级'] : 'C';

    var fields01 = ['典型经营主体形态', '必备证照资质', '常见经营规模', '订单与客户来源', '典型融资用途'];
    var fields03 = ['前景趋势判断', '毛利率区间', '净利率区间', '旺季月份', '淡季月份', '季节性资金缺口高峰', '主要经营风险', '政策与外部驱动'];

    var f01Html = fields01.map(function(f) {
      return '<div class="kv"><span class="kv-k">' + esc2(f) + '</span><span class="kv-v">' + esc2(ind[f]) + '</span></div>';
    }).join('');

    var f03Html = fields03.map(function(f) {
      return '<div class="kv"><span class="kv-k">' + esc2(f) + '</span><span class="kv-v">' + esc2(ind[f]) + '</span></div>';
    }).join('');

    var modesHtml = indModes.slice(0, 3).map(function(m) {
      var mFields = ['细分模式', '运作方式', '盈利逻辑', '上下游与结算回款方式', '成本结构', '资金需求特点与周期', '授信关注要点'];
      var mRows = mFields.map(function(mf) {
        var label = mf === '上下游与结算回款方式' ? '上下游与结算回款' : mf;
        return '<div class="kv"><span class="kv-k">' + esc2(label) + '</span><span class="kv-v">' + esc2(m[mf]) + '</span></div>';
      }).join('');
      return '<div class="mode-block"><div class="mode-hd">' + esc2(m['细分模式'] || '经营模式') + '</div>' + mRows + '</div>';
    }).join('');

    var jobsHtml = indJobs.slice(0, 5).map(function(j) {
      var sk = j['行业编号'] + '|' + j['常见职位'];
      var sd = DB.salary[sk];
      var salTxt = sd ? (sd.monthly_median/1000).toFixed(1) + 'k' : '-';
      var jFields = ['这个岗位每天干什么', '审核时怎么问', '能查到哪些证据', '真干过的人怎么答', '没干过的破绽', '审批要点'];
      var jRows = jFields.map(function(jf) {
        var label = jf === '这个岗位每天干什么' ? '岗位每天干什么' : jf;
        return '<div class="kv"><span class="kv-k">' + esc2(label) + '</span><span class="kv-v">' + esc2(j[jf]) + '</span></div>';
      }).join('');
      return '<div class="job-block"><div class="job-hd"><span>' + esc2(j['常见职位']) + '</span><span class="job-sal">月薪中位 ' + salTxt + '</span></div>' + jRows + '</div>';
    }).join('');

    var riskBadges = indRisks.slice(0, 8).map(function(r) {
      return '<span class="rbadge" style="background:' + lvBg[r['风险层级']] + ';color:' + lvColors[r['风险层级']] + '">' + esc2(r['城市']) + ' ' + r['风险层级'] + '</span>';
    }).join('');
    if (!riskBadges) riskBadges = '<span style="color:#94a3b8;font-size:12px">暂无城市风险数据</span>';

    return '<div class="ind-card page-break">' +
      '<div class="ind-hd">' +
        '<div class="ind-num">' + esc2(ind['行业编号']) + '</div>' +
        '<div class="ind-info"><div class="ind-name">' + esc2(ind['细分行业']) + '</div>' +
        '<div class="ind-cat">' + esc2(ind['行业大类']) + '</div></div>' +
        '<div class="ind-lv" style="background:' + lvBg[riskLv] + ';color:' + lvColors[riskLv] + '">' + riskLv + ' ' + lvText[riskLv] + '</div>' +
      '</div>' +
      '<div class="ind-sec"><div class="ind-sec-hd">经营基本面</div><div class="kv-grid">' + f01Html + '</div></div>' +
      '<div class="ind-sec"><div class="ind-sec-hd">财务与风险特征</div><div class="kv-grid">' + f03Html + '</div></div>' +
      (modesHtml ? '<div class="ind-sec"><div class="ind-sec-hd">经营模式分析</div>' + modesHtml + '</div>' : '') +
      (jobsHtml ? '<div class="ind-sec"><div class="ind-sec-hd">核心岗位与电核要点</div>' + jobsHtml + '</div>' : '') +
      '<div class="ind-sec"><div class="ind-sec-hd">城市风险分布</div><div class="rbadge-row">' + riskBadges + '</div></div>' +
    '</div>';
  }).join('');

  // 城市风险卡片
  var cityCardsHtml = cities.slice(0, 10).map(function(cn) {
    var cRisks = filteredRisks.filter(function(r) { return r['城市'] === cn; });
    if (!cRisks.length) return '';
    var cStats = { A: 0, B: 0, C: 0, D: 0 };
    cRisks.forEach(function(r) { if (cStats[r['风险层级']] !== undefined) cStats[r['风险层级']]++; });
    var cTotal = cRisks.length;
    var segs = ['A','B','C','D'].map(function(lv) {
      var pct = cTotal ? (cStats[lv]/cTotal*100) : 0;
      return '<div class="cseg" style="width:' + pct.toFixed(1) + '%;background:' + lvColors[lv] + '">' + (pct > 8 ? cStats[lv] : '') + '</div>';
    }).join('');
    var topInds = cRisks.slice(0, 8).map(function(r) {
      var ind = industries.find(function(i) { return i['行业编号'] === r['行业编号']; });
      return '<div class="cr-row"><span class="cr-lv ' + r['风险层级'] + '">' + r['风险层级'] + '</span><span class="cr-name">' + esc2(ind ? ind['细分行业'] : r['行业编号']) + '</span></div>';
    }).join('');
    return '<div class="city-card">' +
      '<div class="city-hd"><span class="city-name">' + esc2(cn) + '</span><span class="city-total">共 ' + cTotal + ' 条风险记录</span></div>' +
      '<div class="cbar">' + segs + '</div>' +
      '<div class="clegend">' +
        '<span><i style="background:' + lvColors.A + '"></i>A ' + cStats.A + '</span>' +
        '<span><i style="background:' + lvColors.B + '"></i>B ' + cStats.B + '</span>' +
        '<span><i style="background:' + lvColors.C + '"></i>C ' + cStats.C + '</span>' +
        '<span><i style="background:' + lvColors.D + '"></i>D ' + cStats.D + '</span>' +
      '</div>' +
      '<div class="cr-list">' + topInds + '</div>' +
    '</div>';
  }).join('');

  // 薪资分布
  var salBins = { '3K以下': 0, '3-5K': 0, '5-8K': 0, '8-12K': 0, '12-20K': 0, '20-30K': 0, '30K以上': 0 };
  jobs.forEach(function(j) {
    var sk = j['行业编号'] + '|' + j['常见职位'];
    var sd = DB.salary[sk];
    if (!sd) return;
    var m = sd.monthly_median;
    if (m < 3000) salBins['3K以下']++;
    else if (m < 5000) salBins['3-5K']++;
    else if (m < 8000) salBins['5-8K']++;
    else if (m < 12000) salBins['8-12K']++;
    else if (m < 20000) salBins['12-20K']++;
    else if (m < 30000) salBins['20-30K']++;
    else salBins['30K以上']++;
  });
  var maxBin = Math.max.apply(null, Object.values(salBins));
  var salHtml = Object.entries(salBins).map(function(entry) {
    var name = entry[0], count = entry[1];
    var pct = maxBin ? (count/maxBin*100) : 0;
    return '<div class="sal-row"><span class="sal-l">' + name + '</span><div class="sal-t"><div class="sal-f" style="width:' + pct.toFixed(1) + '%"></div></div><span class="sal-v">' + count + '</span></div>';
  }).join('');

  // 行业大类分布
  var catMap = {};
  industries.forEach(function(i) { var cat = i['行业大类'] || '其他'; catMap[cat] = (catMap[cat]||0)+1; });
  var topCats = Object.entries(catMap).sort(function(a,b){return b[1]-a[1];}).slice(0, 10);
  var maxCat = topCats.length ? topCats[0][1] : 1;
  var catHtml = topCats.map(function(entry) {
    return '<div class="cat-row"><span class="cat-l">' + esc2(entry[0]) + '</span><div class="cat-t"><div class="cat-f" style="width:' + (entry[1]/maxCat*100).toFixed(1) + '%"></div></div><span class="cat-v">' + entry[1] + '</span></div>';
  }).join('');

  // 选定项摘要
  var selIndNames = industries.slice(0, 5).map(function(i) { return i['细分行业']; }).join('、');
  var selJobNames = jobs.slice(0, 5).map(function(j) { return j['常见职位']; }).join('、');
  var selCityNames = cities.slice(0, 5).join('、');

  var reportHtml = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>信贷风控专业分析报告</title><style>' +
    '*{margin:0;padding:0;box-sizing:border-box}' +
    'body{font-family:"Microsoft YaHei","PingFang SC","Helvetica Neue",sans-serif;color:#1e293b;background:#f1f5f9;font-size:14px;line-height:1.7}' +
    '.rp{max-width:920px;margin:0 auto;padding:32px}' +
    '.cover{text-align:center;padding:90px 50px 70px;background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 35%,#3b82f6 65%,#06b6d4 100%);color:#fff;border-radius:0 0 24px 24px;margin-bottom:36px;position:relative;overflow:hidden}' +
    '.cover::before{content:"";position:absolute;top:-40%;right:-15%;width:380px;height:380px;background:radial-gradient(circle,rgba(255,255,255,.08) 0%,transparent 70%);border-radius:50%}' +
    '.cover::after{content:"";position:absolute;bottom:-25%;left:-8%;width:280px;height:280px;background:radial-gradient(circle,rgba(59,130,246,.25) 0%,transparent 70%);border-radius:50%}' +
    '.cover-tag{display:inline-block;padding:6px 20px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);border-radius:20px;font-size:12px;letter-spacing:3px;margin-bottom:28px;position:relative;z-index:1}' +
    '.cover-h1{font-size:36px;font-weight:800;letter-spacing:3px;margin-bottom:12px;position:relative;z-index:1}' +
    '.cover-sub{font-size:14px;opacity:.8;margin-bottom:44px;position:relative;z-index:1;letter-spacing:1px}' +
    '.cover-meta{display:flex;justify-content:center;gap:24px;position:relative;z-index:1;flex-wrap:wrap}' +
    '.cover-meta .cm{background:rgba(255,255,255,.1);padding:20px 32px;border-radius:14px;border:1px solid rgba(255,255,255,.18);min-width:120px}' +
    '.cover-meta .cm span{display:block;font-size:30px;font-weight:800;margin-top:6px}' +
    '.cover-meta .cm small{font-size:13px;opacity:.85}' +
    '.cover-sel{margin-top:24px;font-size:12px;opacity:.75;position:relative;z-index:1;line-height:2;padding:0 20px}' +
    '.cover-date{margin-top:28px;font-size:11px;opacity:.6;position:relative;z-index:1}' +
    '.sec{margin-bottom:32px;background:#fff;border-radius:14px;padding:28px 32px;box-shadow:0 1px 4px rgba(0,0,0,.04)}' +
    '.sec-h{font-size:18px;font-weight:700;color:#0f172a;border-left:4px solid #3b82f6;padding-left:12px;margin-bottom:6px;display:flex;align-items:center;gap:8px}' +
    '.sec-h .num{display:inline-flex;width:24px;height:24px;background:#3b82f6;color:#fff;border-radius:6px;font-size:13px;align-items:center;justify-content:center;margin-left:-4px}' +
    '.sec-sub{color:#64748b;font-size:12px;margin-bottom:18px;padding-left:16px}' +
    '.ov-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}' +
    '.ov-c{background:linear-gradient(135deg,#f8fafc,#f1f5f9);border-radius:10px;padding:20px 16px;text-align:center;border:1px solid #e2e8f0;position:relative;overflow:hidden}' +
    '.ov-c::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#3b82f6,#8b5cf6)}' +
    '.ov-c:nth-child(2)::before{background:linear-gradient(90deg,#06b6d4,#10b981)}' +
    '.ov-c:nth-child(3)::before{background:linear-gradient(90deg,#f59e0b,#f97316)}' +
    '.ov-c:nth-child(4)::before{background:linear-gradient(90deg,#8b5cf6,#ec4899)}' +
    '.ov-n{font-size:28px;font-weight:800;color:#0f172a}' +
    '.ov-l{font-size:12px;color:#64748b;margin-top:4px}' +
    '.ins{padding:14px 18px;border-radius:8px;margin-top:14px;font-size:13px;line-height:1.8}' +
    '.ins.blue{background:#eff6ff;color:#1e40af;border-left:3px solid #3b82f6}' +
    '.ins.green{background:#f0fdf4;color:#166534;border-left:3px solid #22c55e}' +
    '.ins.amber{background:#fffbeb;color:#92400e;border-left:3px solid #f59e0b}' +
    '.ins.red{background:#fef2f2;color:#991b1b;border-left:3px solid #ef4444}' +
    '.ind-card{margin-bottom:24px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;page-break-inside:avoid}' +
    '.ind-hd{display:flex;align-items:center;gap:12px;padding:16px 20px;background:linear-gradient(90deg,#f8fafc,#f1f5f9);border-bottom:1px solid #e2e8f0}' +
    '.ind-num{font-size:11px;font-weight:700;color:#fff;background:#3b82f6;padding:4px 10px;border-radius:6px;flex-shrink:0}' +
    '.ind-info{flex:1;min-width:0}' +
    '.ind-name{font-size:16px;font-weight:700;color:#0f172a}' +
    '.ind-cat{font-size:12px;color:#64748b;margin-top:2px}' +
    '.ind-lv{font-size:12px;font-weight:700;padding:6px 14px;border-radius:6px;flex-shrink:0}' +
    '.ind-sec{padding:14px 20px;border-bottom:1px solid #f1f5f9}' +
    '.ind-sec:last-child{border-bottom:0}' +
    '.ind-sec-hd{font-size:13px;font-weight:600;color:#3b82f6;margin-bottom:10px}' +
    '.kv-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px}' +
    '.kv{display:flex;gap:8px;font-size:12px;line-height:1.6}' +
    '.kv-k{color:#64748b;flex-shrink:0;min-width:90px}' +
    '.kv-v{color:#334155;flex:1;word-break:break-all}' +
    '.mode-block{background:#f8fafc;border-radius:8px;padding:12px 16px;margin-bottom:10px;border-left:3px solid #06b6d4}' +
    '.mode-hd{font-size:13px;font-weight:600;color:#0e7490;margin-bottom:8px}' +
    '.job-block{background:#fefce8;border-radius:8px;padding:12px 16px;margin-bottom:10px;border-left:3px solid #f59e0b}' +
    '.job-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}' +
    '.job-hd span:first-child{font-size:14px;font-weight:600;color:#92400e}' +
    '.job-sal{font-size:12px;font-weight:600;color:#d97706;background:#fffbeb;padding:2px 10px;border-radius:4px}' +
    '.rbadge-row{display:flex;flex-wrap:wrap;gap:6px}' +
    '.rbadge{font-size:11px;font-weight:600;padding:3px 10px;border-radius:4px}' +
    '.city-card{border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin-bottom:14px;page-break-inside:avoid}' +
    '.city-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}' +
    '.city-name{font-size:15px;font-weight:700;color:#0f172a}' +
    '.city-total{font-size:12px;color:#64748b}' +
    '.cbar{display:flex;height:28px;border-radius:6px;overflow:hidden;margin-bottom:8px}' +
    '.cseg{display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600}' +
    '.clegend{display:flex;gap:16px;margin-bottom:10px;font-size:12px;color:#475569}' +
    '.clegend span{display:flex;align-items:center;gap:4px}' +
    '.clegend i{width:8px;height:8px;border-radius:2px;display:inline-block}' +
    '.cr-list{display:grid;grid-template-columns:1fr 1fr;gap:4px 16px}' +
    '.cr-row{display:flex;align-items:center;gap:8px;font-size:12px}' +
    '.cr-lv{font-size:10px;font-weight:700;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:3px;color:#fff;flex-shrink:0}' +
    '.cr-lv.A{background:#059669}.cr-lv.B{background:#3b82f6}.cr-lv.C{background:#d97706}.cr-lv.D{background:#dc2626}' +
    '.cr-name{color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.sal-row{display:flex;align-items:center;gap:10px;margin-bottom:6px}' +
    '.sal-l{width:70px;font-size:12px;color:#475569;flex-shrink:0}' +
    '.sal-t{flex:1;height:22px;background:#f1f5f9;border-radius:4px;overflow:hidden}' +
    '.sal-f{height:100%;background:linear-gradient(90deg,#3b82f6,#60a5fa);border-radius:4px}' +
    '.sal-v{width:36px;text-align:right;font-size:12px;font-weight:600;color:#1e40af;flex-shrink:0}' +
    '.cat-row{display:flex;align-items:center;gap:10px;margin-bottom:6px}' +
    '.cat-l{width:140px;font-size:12px;color:#334155;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.cat-t{flex:1;height:20px;background:#f1f5f9;border-radius:4px;overflow:hidden}' +
    '.cat-f{height:100%;background:linear-gradient(90deg,#10b981,#34d399);border-radius:4px}' +
    '.cat-v{width:32px;text-align:right;font-size:12px;color:#64748b;flex-shrink:0}' +
    '.footer{margin-top:36px;padding-top:20px;border-top:1px solid #e2e8f0;text-align:center;color:#94a3b8;font-size:11px}' +
    '.footer .brand{color:#3b82f6;font-weight:700;font-size:13px;margin-bottom:4px}' +
    '@media print{body{background:#fff}.rp{padding:0;max-width:100%}.cover{border-radius:0}.sec{page-break-inside:avoid;box-shadow:none;border:1px solid #e2e8f0}.page-break{page-break-inside:avoid}}' +
    '</style></head><body><div class="rp">' +
    '<div class="cover">' +
      '<div class="cover-tag">CREDIT RISK ANALYSIS REPORT</div>' +
      '<div class="cover-h1">信贷风控专业分析报告</div>' +
      '<div class="cover-sub">基于小微行业知识库的多维度信贷风险评估</div>' +
      '<div class="cover-meta">' +
        '<div class="cm"><small>细分行业</small><span>' + indCount + '</span></div>' +
        '<div class="cm"><small>职业岗位</small><span>' + jobCount + '</span></div>' +
        '<div class="cm"><small>覆盖城市</small><span>' + cityCount + '</span></div>' +
        '<div class="cm"><small>风险记录</small><span>' + filteredRisks.length + '</span></div>' +
      '</div>' +
      (selIndNames ? '<div class="cover-sel"><strong>选定行业：</strong>' + esc2(selIndNames) + (industries.length > 5 ? ' 等' + industries.length + '个' : '') + '</div>' : '') +
      (selJobNames ? '<div class="cover-sel"><strong>选定岗位：</strong>' + esc2(selJobNames) + (jobs.length > 5 ? ' 等' + jobs.length + '个' : '') + '</div>' : '') +
      (selCityNames ? '<div class="cover-sel"><strong>选定城市：</strong>' + esc2(selCityNames) + (cities.length > 5 ? ' 等' + cities.length + '个' : '') + '</div>' : '') +
      '<div class="cover-date">报告生成日期：' + today + ' | 小微行业知识库</div>' +
    '</div>' +
    '<div class="sec"><div class="sec-h"><span class="num">1</span>数据概览</div><div class="sec-sub">基于当前筛选条件的核心指标汇总</div>' +
      '<div class="ov-grid">' +
        '<div class="ov-c"><div class="ov-n">' + indCount + '</div><div class="ov-l">细分行业</div></div>' +
        '<div class="ov-c"><div class="ov-n">' + jobCount + '</div><div class="ov-l">职业岗位</div></div>' +
        '<div class="ov-c"><div class="ov-n">' + cityCount + '</div><div class="ov-l">覆盖城市</div></div>' +
        '<div class="ov-c"><div class="ov-n">' + (avgSalary ? (avgSalary/1000).toFixed(1)+'k' : '-') + '</div><div class="ov-l">平均月薪</div></div>' +
      '</div>' +
      '<div class="ins blue"><strong>报告说明：</strong>本报告基于小微行业知识库数据生成，涵盖行业基本面、经营模式、职业电核、城市风险、薪资水平等多维度分析，适用于银行信贷审批、行业研究、尽职调查等场景。数据仅供参考，实际决策请结合现场尽调。</div>' +
    '</div>' +
    '<div class="sec"><div class="sec-h"><span class="num">2</span>行业大类分布</div><div class="sec-sub">按行业大类的细分行业数量分布</div>' + catHtml + '</div>' +
    '<div class="sec"><div class="sec-h"><span class="num">3</span>薪资水平分析</div><div class="sec-sub">月薪中位数分布（共 ' + jobCount + ' 个职位）</div>' + salHtml +
      '<div class="ins green"><strong>薪资洞察：</strong>平均月薪 ' + (avgSalary ? (avgSalary/1000).toFixed(1)+'k' : '-') + '，' +
      (salBins['8-12K'] > jobCount * 0.3 ? '主力薪资区间在8-12K，属于中等收入水平。' : salBins['3-5K'] > jobCount * 0.3 ? '入门岗占比较高，薪资水平偏低。' : '中高收入岗位占比较大。') + '</div></div>' +
    '<div class="sec"><div class="sec-h"><span class="num">4</span>风险等级分析</div><div class="sec-sub">城市风险等级分布（共 ' + filteredRisks.length + ' 条记录）</div>' +
      '<div style="display:flex;height:36px;border-radius:8px;overflow:hidden;margin:12px 0">' +
        '<div style="width:' + (filteredRisks.length ? (riskStats.A/filteredRisks.length*100).toFixed(1) : 0) + '%;background:' + lvColors.A + ';display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:600">' + (riskStats.A ? 'A '+riskStats.A : '') + '</div>' +
        '<div style="width:' + (filteredRisks.length ? (riskStats.B/filteredRisks.length*100).toFixed(1) : 0) + '%;background:' + lvColors.B + ';display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:600">' + (riskStats.B ? 'B '+riskStats.B : '') + '</div>' +
        '<div style="width:' + (filteredRisks.length ? (riskStats.C/filteredRisks.length*100).toFixed(1) : 0) + '%;background:' + lvColors.C + ';display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:600">' + (riskStats.C ? 'C '+riskStats.C : '') + '</div>' +
        '<div style="width:' + (filteredRisks.length ? (riskStats.D/filteredRisks.length*100).toFixed(1) : 0) + '%;background:' + lvColors.D + ';display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:600">' + (riskStats.D ? 'D '+riskStats.D : '') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:20px;font-size:12px;color:#475569">' +
        '<span><i style="background:' + lvColors.A + ';width:8px;height:8px;border-radius:2px;display:inline-block"></i> A ' + lvText.A + ' (' + riskStats.A + ')</span>' +
        '<span><i style="background:' + lvColors.B + ';width:8px;height:8px;border-radius:2px;display:inline-block"></i> B ' + lvText.B + ' (' + riskStats.B + ')</span>' +
        '<span><i style="background:' + lvColors.C + ';width:8px;height:8px;border-radius:2px;display:inline-block"></i> C ' + lvText.C + ' (' + riskStats.C + ')</span>' +
        '<span><i style="background:' + lvColors.D + ';width:8px;height:8px;border-radius:2px;display:inline-block"></i> D ' + lvText.D + ' (' + riskStats.D + ')</span>' +
      '</div></div>' +
    '<div class="sec"><div class="sec-h"><span class="num">5</span>细分行业深度分析</div><div class="sec-sub">每个选定行业的经营基本面、财务特征、经营模式、核心岗位与城市风险</div>' + indCardsHtml + '</div>' +
    (cityCardsHtml ? '<div class="sec"><div class="sec-h"><span class="num">6</span>城市风险分析</div><div class="sec-sub">选定城市的风险等级分布与行业明细</div>' + cityCardsHtml + '</div>' : '') +
    '<div class="sec"><div class="sec-h"><span class="num">7</span>授信建议</div>' +
      '<div class="ins amber"><strong>授信提示：</strong>不同行业经营模式差异较大，建议结合具体细分行业的经营模式、资金周期、淡旺季特征综合评估授信方案。重点关注：季节性资金缺口、应收账款周期、存货周转、现金流稳定性。</div>' +
      '<div class="ins red"><strong>风险关注：</strong>高风险等级（D级）行业需加强贷前尽调，重点关注经营稳定性、政策合规性、竞争格局变化。中风险（C级）行业需关注季节性波动和资金链断裂风险。</div>' +
      '<div class="ins green"><strong>放款建议：</strong>低风险（A/B级）行业可适当优化审批流程，关注毛利率水平和现金流覆盖能力。建议结合具体城市风险等级、行业淡旺季特征制定差异化授信方案。</div>' +
    '</div>' +
    '<div class="footer"><div class="brand">小微行业知识库 · Professional</div>' +
      '<div>报告生成日期：' + today + ' | 数据来源：小微行业知识库</div>' +
      '<div style="margin-top:4px;font-size:10px">本报告仅供参考，不构成任何投资或授信建议。使用前请自行核实数据准确性。</div>' +
    '</div>' +
    '</div>' +
    '</body></html>';

  // 用iframe加载完整报告文档（确保CSS正确解析），再html2canvas截图+jsPDF下载
  var iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:920px;height:200px;border:0';
  document.body.appendChild(iframe);

  toast('正在生成PDF', '请稍候，正在渲染报告内容...', 'ok');

  iframe.onload = function() {
    setTimeout(function() {
      var renderEl = iframe.contentWindow.document.querySelector('.rp');
      if (!renderEl) { document.body.removeChild(iframe); return; }

      html2canvas(renderEl, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#f1f5f9',
        windowWidth: 920,
        logging: false,
        document: iframe.contentWindow.document
      }).then(function(canvas) {
        document.body.removeChild(iframe);

        var imgWidth = 595.28;
        var pageHeight = 841.89;
        var imgHeight = canvas.height * imgWidth / canvas.width;

        var pdf = new jspdf.jsPDF('p', 'pt', 'a4');
        var heightLeft = imgHeight;
        var position = 0;

        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;

        while (heightLeft > 0) {
          position -= pageHeight;
          pdf.addPage();
          pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, position, imgWidth, imgHeight);
          heightLeft -= pageHeight;
        }

        var fileName = '信贷风控专业分析报告_' + today.replace(/\//g, '') + '.pdf';
        pdf.save(fileName);
        toast('PDF下载完成', '报告已保存为 ' + fileName, 'ok');
      }).catch(function(err) {
        document.body.removeChild(iframe);
        console.error('PDF生成失败:', err);
        toast('生成失败', '正在尝试备用方案（浏览器打印）...', 'ok');

        var iframe2 = document.createElement('iframe');
        iframe2.style.cssText = 'position:fixed;left:-9999px;top:0;width:920px;height:600px;border:0';
        document.body.appendChild(iframe2);
        iframe2.onload = function() {
          setTimeout(function() {
            try {
              iframe2.contentWindow.focus();
              iframe2.contentWindow.print();
            } catch(e) {
              var w = window.open('', '_blank');
              if (w) { w.document.write(reportHtml); w.document.close(); }
            }
            setTimeout(function() { document.body.removeChild(iframe2); }, 1000);
          }, 300);
        };
        var doc2 = iframe2.contentWindow.document;
        doc2.open();
        doc2.write(reportHtml);
        doc2.close();
      });
    }, 500);
  };

  var doc = iframe.contentWindow.document;
  doc.open();
  doc.write(reportHtml);
  doc.close();
}

// ================================================================== 导出弹窗

function showExportModal(inds, jobs, cities, allJobs, allRisks) {

  let html = '<div class="exp-options"><h4>选择导出内容</h4>';

  html += '<label class="chk"><input type="checkbox" id="expInd" checked> 行业信息</label>';

  html += '<label class="chk"><input type="checkbox" id="expJob" checked> 职位详情（专家经验）</label>';

  html += '<label class="chk"><input type="checkbox" id="expRisk"> 城市风险</label>';

  html += '<label class="chk"><input type="checkbox" id="expSal"> 薪资数据</label>';

  html += '<hr><h4>导出格式</h4>';

  html += '<label class="chk"><input type="radio" name="expFmt" value="pdf" checked> 📄 PDF专业报告（推荐）</label>';

  html += '<label class="chk"><input type="radio" name="expFmt" value="csv"> CSV（可用Excel打开）</label>';

  html += '<label class="chk"><input type="radio" name="expFmt" value="json"> JSON（原始数据）</label>';

  html += '</div>';

  

  modal('📥 导出数据', html, 

    '<button class="btn" onclick="closeModal()">取消</button>' +

    '<button class="btn green" onclick="doExport()">开始导出</button>');

}



function doExport() {

  const expInd = document.getElementById('expInd').checked;

  const expJob = document.getElementById('expJob').checked;

  const expRisk = document.getElementById('expRisk').checked;

  const expSal = document.getElementById('expSal').checked;

  const fmt = document.querySelector('input[name="expFmt"]:checked').value;

  

  const q = S.dash;

  const inds = q.ci.size ? DB.industries.filter(i => q.ci.has(i['行业编号'])) : DB.industries;

  const jobList = q.cj.size 

    ? DB.jobs.filter(j => q.ci.has(j['行业编号']) && q.cj.has(j['常见职位']))

    : (q.ci.size ? DB.jobs.filter(j => q.ci.has(j['行业编号'])) : DB.jobs);

  const cityList = q.cc.size ? [...q.cc] : DB.cities.map(c => c['城市名称']);

  const risks = DB.city_risks.filter(r => (!q.ci.size || q.ci.has(r['行业编号'])) && (!q.cc.size || q.cc.has(r['城市'])));

  

  if (fmt === 'pdf') {

    generatePdfReport(inds, jobList, cityList, DB.jobs, DB.city_risks);

    closeModal();

    return;

  }

  if (fmt === 'csv') {

    // CSV导出

    let csv = '';

    if (expInd) {

      csv += '【行业信息】\n';

      csv += '行业编号,行业大类,细分行业,前景趋势,毛利率区间,净利率区间\n';

      for (const i of inds) {

        csv += [i['行业编号'], i['行业大类'] || '', i['细分行业'], i['前景趋势判断'] || '', i['毛利率区间'] || '', i['净利率区间'] || '']

          .map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\n';

      }

      csv += '\n';

    }

    if (expJob) {

      csv += '【职位详情】\n';

      csv += '行业编号,细分行业,职位名称,每天干什么,审核时怎么问,审批要点\n';

      for (const j of jobList) {

        csv += [j['行业编号'], j['细分行业'], j['常见职位'], j['这个岗位每天干什么'] || '', j['审核时怎么问'] || '', j['审批要点'] || '']

          .map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\n';

      }

      csv += '\n';

    }

    if (expRisk) {

      csv += '【城市风险】\n';

      csv += '行业编号,城市,风险等级,风险评分\n';

      for (const r of risks) {

        csv += [r['行业编号'], r['城市'], r['风险层级'], r['风险评分']]

          .map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\n';

      }

    }

    

    downloadFile(csv, '小微行业知识库_数据导出.csv', 'text/csv;charset=utf-8');

  } else {

    // JSON导出

    const data = {};

    if (expInd) data.industries = inds;

    if (expJob) data.jobs = jobList;

    if (expRisk) data.city_risks = risks;

    if (expSal) {

      data.salary = {};

      for (const j of jobList) {

        const k = j['行业编号'] + '|' + j['常见职位'];

        if (DB.salary[k]) data.salary[k] = DB.salary[k];

      }

    }

    data.export_time = new Date().toISOString();

    data.source = '小微行业知识库 V4.1';

    

    downloadFile(JSON.stringify(data, null, 2), '小微行业知识库_数据导出.json', 'application/json');

  }

  

  closeModal();

  toast('导出成功', '文件已下载', 'ok');

}



function downloadFile(content, filename, type) {

  const blob = new Blob(['\uFEFF' + content], { type: type || 'text/plain' });

  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');

  a.href = url;

  a.download = filename;

  a.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);

}



// ============================================ 行业一览页
function pageIndOverview(c) {
  const cats = {};
  DB.industries.forEach(i => {
    const cat = i['行业大类'] || '其他';
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(i);
  });

  const cities = DB.cities.map(x => x['城市名称'] || x['城市']);
  const defaultCity = cities[0] || '北京';

  c.innerHTML = '<div style="margin-bottom:16px;display:flex;align-items:center;gap:12px;">' +
    '<label style="font-size:13px;color:#6b7280;">选择城市：</label>' +
    '<select id="indOvwCitySel" class="q-input" style="max-width:200px;">' +
    cities.map(ct => '<option value="' + esc(ct) + '"' + (ct === defaultCity ? ' selected' : '') + '>' + esc(ct) + '</option>').join('') +
    '</select></div>' +
    '<div id="indOvwContent"></div>';

  function render(city) {
    let html = '<div class="page-grid">';
    for (const [cat, inds] of Object.entries(cats)) {
      html += '<div class="card fade-in">' + cardHead('🏢', cat, inds.length + '个细分行业') + '<div class="card-bd"><div class="ind-grid">';
      inds.forEach(i => {
        const risk = DB.city_risks.find(r => r['行业编号'] === i['行业编号'] && r['城市'] === city);
        const level = risk ? risk['风险层级'] : '?';
        const score = risk ? risk['风险评分'] : '?';
        const levelColor = level === 'A' ? '#10b981' : level === 'B' ? '#f59e0b' : level === 'C' ? '#f97316' : '#ef4444';
        html += '<div class="ind-card" data-ind-code="' + esc(i['行业编号']) + '" data-ind-name="' + esc(i['细分行业']) + '" style="cursor:pointer;padding:10px 12px;border:1px solid #e5e7eb;border-radius:8px;display:flex;align-items:center;gap:8px;">';
        html += '<span style="background:' + levelColor + ';color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;min-width:20px;text-align:center;">' + level + '</span>';
        html += '<span style="font-size:13px;">' + i['细分行业'] + '</span>';
        html += '<span style="margin-left:auto;font-size:11px;color:#9ca3af;">' + score + '分</span>';
        html += '</div>';
      });
      html += '</div></div></div>';
    }
    html += '</div>';

    const content = $('#indOvwContent');
    if (content) content.innerHTML = html;

    $$('.ind-card').forEach(el => {
      el.onclick = () => {
        S.dash.industry = el.dataset.indName || '';
        S.dash.ci = new Set([el.dataset.indCode]);
        S.dash.queried = true;
        addRecent('industry', el.dataset.indCode, el.dataset.indName, { city: $('#indOvwCitySel')?.value });
        go('dashboard');
      };
    });
  }

  render(defaultCity);

  const sel = $('#indOvwCitySel');
  if (sel) sel.onchange = () => render(sel.value);
}

// ============================================ 风险速查页
function pageRiskQuick(c) {
  // ====== 1. 准入标准卡片 ======
  const accessRules = [
    { lv: 'A', color: '#10b981', name: 'A级（低风险）', score: '0-30', quota: '最高可贷100万', terms: '利率LPR+1.5%（约4.0%）', term: '最长36期', req: '营业执照满12个月，经营流水稳定', focus: '核实经营真实性、流水稳定性' },
    { lv: 'B', color: '#f59e0b', name: 'B级（中风险）', score: '31-50', quota: '最高可贷50万', terms: '利率LPR+2.5%（约5.0%）', term: '最长24期', req: '营业执照满6个月，提供近6个月流水', focus: '核实经营场所、上下游合同、社保人数' },
    { lv: 'C', color: '#f97316', name: 'C级（中高风险）', score: '51-70', quota: '最高可贷20万', terms: '利率LPR+4%（约6.5%）', term: '最长18期', req: '营业执照满6个月，需增信措施', focus: '增信核实：抵押物/担保人/联保' },
    { lv: 'D', color: '#ef4444', name: 'D级（高风险）', score: '71-100', quota: '原则上拒贷', terms: '—', term: '—', req: '触发预警指标', focus: '触发预警：建议拒贷或上报特殊审批' }
  ];

  const lvColor = s => s === null ? '#f3f4f6' : s <= 30 ? '#10b981' : s <= 50 ? '#f59e0b' : s <= 70 ? '#f97316' : '#ef4444';
  const lvBg = lv => lv === 'A' ? '#dcfce7' : lv === 'B' ? '#fef3c7' : lv === 'C' ? '#ffedd5' : '#fee2e2';
  const lvFg = lv => lv === 'A' ? '#166534' : lv === 'B' ? '#92400e' : lv === 'C' ? '#9a3412' : '#991b1b';

  const allCities = DB.cities.map(x => x['城市名称'] || x['城市']);
  const defaultCity = allCities[0] || '北京';

  // 页面骨架：城市选择器 + 内容区
  c.innerHTML = '<div style="margin-bottom:16px;display:flex;align-items:center;gap:12px;">' +
    '<label style="font-size:13px;color:#6b7280;">基准城市：</label>' +
    '<select id="riskCitySel" class="q-input" style="max-width:200px;">' +
    allCities.map(ct => '<option value="' + esc(ct) + '"' + (ct === defaultCity ? ' selected' : '') + '>' + esc(ct) + '</option>').join('') +
    '</select></div>' +
    '<div id="riskQuickContent"></div>';

  function renderRiskQuick(city) {
    // ====== 2. 风险阈值表（自动预警） ======
    const thresholdData = DB.city_risks.filter(r => r['城市'] === city);
    const totalInd = thresholdData.length;
    const aCount = thresholdData.filter(r => r['风险层级'] === 'A').length;
    const bCount = thresholdData.filter(r => r['风险层级'] === 'B').length;
    const cCount = thresholdData.filter(r => r['风险层级'] === 'C').length;
    const dCount = thresholdData.filter(r => r['风险层级'] === 'D').length;
    const avgScore = totalInd ? Math.round(thresholdData.reduce((s, r) => s + (r['风险评分'] || 0), 0) / totalInd) : 0;
    const highRiskPct = totalInd ? Math.round((cCount + dCount) / totalInd * 100) : 0;

    // ====== 3. 典型案例 ======
    const cases = [
      { type: '正常', lv: 'A', color: '#10b981', title: '正餐中餐 · ' + city, summary: '某火锅连锁店，3家门店，月流水80万，经营5年', detail: '核实：3家门店租赁合同、POS流水、食材采购合同、员工社保8人。准贷30万，利率4.0%，36期。', lesson: 'A级客户重点核实经营真实性和流水稳定性' },
      { type: '违约', lv: 'D', color: '#ef4444', title: '小吃快餐 · 某城市', summary: '某炸鸡店，开业6个月，月流水15万，借款人无餐饮经验', detail: '风险点：经营时间短于12个月、借款人无行业经验、流水波动大、无法提供完整采购凭证。建议拒贷或要求增信。', lesson: 'D级风险评分>70：触发预警，建议拒贷或特殊审批' }
    ];

    // ====== 4. 同行业不同城市横向对比 ======
    const cities = allCities.slice(0, 10);
    const sampleCodes = DB.city_risks.filter(r => r['城市'] === city).slice(0, 8).map(r => r['行业编号']);
    const compareData = sampleCodes.map(code => {
      const ind = DB.industries.find(i => i['行业编号'] === code);
      const name = ind ? ind['细分行业'] : code;
      const row = { code, name, cities: {} };
      cities.forEach(ct => {
        const r = DB.city_risks.find(x => x['行业编号'] === code && x['城市'] === ct);
        if (r) row.cities[ct] = { lv: r['风险层级'], score: r['风险评分'] };
      });
      return row;
    });

    // ====== 5. 热力图数据（行业 × 城市） ======
    const heatCities = cities.slice(0, 8);
    const heatCodes = sampleCodes.slice(0, 6);
    const heatData = heatCodes.map(code => {
      const ind = DB.industries.find(i => i['行业编号'] === code);
      const name = ind ? ind['细分行业'] : code;
      const row = { name, vals: heatCities.map(ct => {
        const r = DB.city_risks.find(x => x['行业编号'] === code && x['城市'] === ct);
        return r ? r['风险评分'] : null;
      }) };
      return row;
    });

    let html = '<div class="card fade-in"><div class="card-bd"><div class="sec-h">📊 风险速查总览</div>';
    html += '<p class="hint" data-tip="风险评分综合行业风险、城市产业匹配度、经营稳定性等维度&#10;评分越高代表风险越大&#10;阈值：A=0-30 B=31-50 C=51-70 D=71-100">基于行业×城市风险矩阵，按层级分类，评分>60自动预警。点击行业名可进入详情。</p>';
    html += '</div></div>';

    // ====== 准入标准卡片 ======
    html += '<div class="sec-h" style="margin:18px 0 12px">准入标准卡片</div>';
    html += '<div class="page-grid">';
    for (const r of accessRules) {
      html += '<div class="card fade-in" style="border-top:3px solid ' + r.color + '">';
      html += '<div class="card-bd">';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">';
      html += '<span style="background:' + r.color + ';color:#fff;padding:4px 10px;border-radius:4px;font-weight:600">' + r.lv + '</span>';
      html += '<span style="font-weight:600">' + r.name + '</span>';
      html += '<span style="margin-left:auto;color:#6b7280;font-size:13px">评分 ' + r.score + '</span>';
      html += '</div>';
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px">';
      html += '<div><span style="color:#6b7280">可贷额度：</span><b>' + r.quota + '</b></div>';
      html += '<div><span style="color:#6b7280">利率：</span><b>' + r.terms + '</b></div>';
      html += '<div><span style="color:#6b7280">期限：</span><b>' + r.term + '</b></div>';
      html += '<div><span style="color:#6b7280">准入要求：</span><b>' + r.req + '</b></div>';
      html += '</div>';
      html += '<div style="margin-top:10px;padding:8px;background:#f9fafb;border-radius:6px;font-size:12px;color:#374151">';
      html += '<b>尽调重点：</b>' + r.focus;
      html += '</div>';
      html += '</div></div>';
    }
    html += '</div>';

    // ====== 风险阈值表 ======
    html += '<div class="card fade-in" style="margin-top:18px"><div class="card-bd"><div class="sec-h">风险阈值表（自动预警）</div>';
    html += '<table class="tbl"><thead><tr><th>风险层级</th><th>评分区间</th><th>行业数量</th><th>占比</th><th>处置建议</th></tr></thead><tbody>';
    for (const r of accessRules) {
      const cnt = r.lv === 'A' ? aCount : r.lv === 'B' ? bCount : r.lv === 'C' ? cCount : dCount;
      const pct = totalInd ? (cnt / totalInd * 100).toFixed(1) : 0;
      html += '<tr>';
      html += '<td><span style="background:' + lvBg(r.lv) + ';color:' + lvFg(r.lv) + ';padding:2px 8px;border-radius:4px;font-weight:600">' + r.lv + '</span></td>';
      html += '<td>' + r.score + '</td>';
      html += '<td>' + cnt + '</td>';
      html += '<td>' + pct + '%</td>';
      html += '<td>' + (r.lv === 'A' ? '正常受理' : r.lv === 'B' ? '加强尽调' : r.lv === 'C' ? '增信措施' : '拒贷/特殊审批') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += '<div style="margin-top:10px;display:flex;gap:16px;font-size:13px;color:#6b7280">';
    html += '<span>样本：' + esc(city) + '市场 ' + totalInd + ' 个行业</span>';
    html += '<span>平均评分：<b>' + avgScore + '</b></span>';
    html += '<span>高风险占比（C+D）：<b style="color:#ef4444">' + highRiskPct + '%</b></span>';
    html += '</div>';
    html += '</div></div>';

    // ====== 同行业不同城市横向对比 ======
    html += '<div class="card fade-in" style="margin-top:18px"><div class="card-bd"><div class="sec-h">同行业不同城市横向对比</div>';
    html += '<div class="tbl-wrap"><table class="tbl" style="font-size:12px"><thead><tr><th>细分行业</th>';
    cities.forEach(ct => html += '<th>' + esc(ct) + '</th>');
    html += '</tr></thead><tbody>';
    for (const row of compareData) {
      html += '<tr><td><b>' + esc(row.name) + '</b></td>';
      cities.forEach(ct => {
        const v = row.cities[ct];
        if (v) {
          html += '<td style="text-align:center"><span style="background:' + lvBg(v.lv) + ';color:' + lvFg(v.lv) + ';padding:2px 6px;border-radius:3px;font-size:11px">' + v.lv + ' ' + v.score + '</span></td>';
        } else {
          html += '<td style="text-align:center;color:#9ca3af">—</td>';
        }
      });
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    html += '<p class="hint" style="margin-top:8px">颜色：A=绿 B=黄 C=橙 D=红，数值越大风险越高。同一行业在不同城市风险评分不同，与城市产业匹配度相关。</p>';
    html += '</div></div>';

    // ====== 热力图 ======
    html += '<div class="card fade-in" style="margin-top:18px"><div class="card-bd">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
    html += '<div class="sec-h" style="margin:0;">行业 × 城市 风险热力图</div>';
    html += '<div id="heatSortBtns" class="heat-sort-btns">';
    html += '<button class="btn btn-xs heat-sort-btn active" data-sort="default">默认</button>';
    html += '<button class="btn btn-xs heat-sort-btn" data-sort="high">风险从高到低</button>';
    html += '<button class="btn btn-xs heat-sort-btn" data-sort="low">风险从低到高</button>';
    html += '</div></div>';
    html += '<div id="heatmapContainer" style="overflow-x:auto"><table style="border-collapse:separate;border-spacing:3px;font-size:11px">';
    html += '<thead><tr><th style="padding:4px 8px"></th>';
    heatCities.forEach(ct => html += '<th style="padding:4px 6px;text-align:center">' + esc(ct) + '</th>');
    html += '</tr></thead><tbody id="heatmapBody">';
    function renderHeatmapRows(data) {
      let rows = '';
      for (const row of data) {
        rows += '<tr><td style="padding:4px 8px;font-weight:600;white-space:nowrap">' + esc(row.name) + '</td>';
        row.vals.forEach(v => {
          if (v === null) {
            rows += '<td style="background:#f3f4f6;padding:8px 10px;text-align:center;color:#9ca3af">—</td>';
          } else {
            rows += '<td style="background:' + lvColor(v) + ';color:#fff;padding:8px 10px;text-align:center;font-weight:600;border-radius:3px">' + v + '</td>';
          }
        });
        rows += '</tr>';
      }
      return rows;
    }
    html += renderHeatmapRows(heatData);
    html += '</tbody></table></div>';
    html += '<div style="margin-top:10px;display:flex;gap:12px;font-size:11px;color:#6b7280">';
    html += '<span><span style="display:inline-block;width:10px;height:10px;background:#10b981;border-radius:2px"></span> A=0-30</span>';
    html += '<span><span style="display:inline-block;width:10px;height:10px;background:#f59e0b;border-radius:2px"></span> B=31-50</span>';
    html += '<span><span style="display:inline-block;width:10px;height:10px;background:#f97316;border-radius:2px"></span> C=51-70</span>';
    html += '<span><span style="display:inline-block;width:10px;height:10px;background:#ef4444;border-radius:2px"></span> D=71-100</span>';
    html += '</div>';
    html += '</div></div>';
    
    // 保存热力图数据供排序使用
    window._heatData = heatData;
    window._renderHeatmapRows = renderHeatmapRows;

    // ====== 典型案例 ======
    html += '<div class="sec-h" style="margin:18px 0 12px">典型案例（违约 / 正常）</div>';
    html += '<div class="page-grid">';
    for (const cs of cases) {
      html += '<div class="card fade-in" style="border-top:3px solid ' + cs.color + '">';
      html += '<div class="card-bd">';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">';
      html += '<span style="background:' + cs.color + ';color:#fff;padding:3px 10px;border-radius:4px;font-size:12px">' + cs.type + '</span>';
      html += '<span style="font-weight:600">' + cs.title + '</span>';
      html += '</div>';
      html += '<p style="font-size:13px;color:#374151;margin-bottom:8px">' + cs.summary + '</p>';
      html += '<p style="font-size:12px;color:#6b7280;line-height:1.6">' + cs.detail + '</p>';
      html += '<div style="margin-top:8px;padding:8px;background:#f9fafb;border-radius:6px;font-size:12px">';
      html += '<b>经验总结：</b>' + cs.lesson;
      html += '</div>';
      html += '</div></div>';
    }
    html += '</div>';

    const content = $('#riskQuickContent');
    if (content) content.innerHTML = html;
    
    // 绑定热力图排序事件
    const sortBtns = $$('.heat-sort-btn', content);
    const origData = window._heatData ? window._heatData.slice() : [];
    sortBtns.forEach(btn => {
      btn.onclick = () => {
        sortBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const sort = btn.dataset.sort;
        let sorted = [...origData];
        if (sort === 'high') {
          sorted.sort((a, b) => {
            const aAvg = a.vals.filter(x => x !== null).reduce((s, v) => s + v, 0) / (a.vals.filter(x => x !== null).length || 1);
            const bAvg = b.vals.filter(x => x !== null).reduce((s, v) => s + v, 0) / (b.vals.filter(x => x !== null).length || 1);
            return bAvg - aAvg;
          });
        } else if (sort === 'low') {
          sorted.sort((a, b) => {
            const aAvg = a.vals.filter(x => x !== null).reduce((s, v) => s + v, 0) / (a.vals.filter(x => x !== null).length || 1);
            const bAvg = b.vals.filter(x => x !== null).reduce((s, v) => s + v, 0) / (b.vals.filter(x => x !== null).length || 1);
            return aAvg - bAvg;
          });
        }
        const body = $('#heatmapBody', content);
        if (body && window._renderHeatmapRows) {
          body.innerHTML = window._renderHeatmapRows(sorted);
        }
      };
    });
  }

  renderRiskQuick(defaultCity);

  const sel = $('#riskCitySel');
  if (sel) sel.onchange = () => renderRiskQuick(sel.value);
}

// ============================================ 城市风控总览页
function pageCityOverview() {
  const cities = DB.cities.map(c => c['城市名称'] || c['城市']);
  let selectedCity = cities[0];

  let html = '<div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap;">';
  cities.forEach((c, i) => {
    html += '<button class="city-ovw-btn" data-city="' + esc(c) + '" style="padding:6px 14px;border:1px solid #e5e7eb;border-radius:6px;background:' + (i === 0 ? '#e0f2fe' : '#fff') + ';font-size:13px;cursor:pointer;' + (i === 0 ? 'font-weight:bold;' : '') + '">' + c + '</button>';
  });
  html += '</div>';

  // 预生成每个城市的数据
  const cityData = {};
  cities.forEach(city => {
    const cityRisks = DB.city_risks.filter(r => r['城市'] === city).sort((a, b) => b['风险评分'] - a['风险评分']);
    const levelCount = { 'A': 0, 'B': 0, 'C': 0, 'D': 0 };
    cityRisks.forEach(r => { if (levelCount[r['风险层级']] !== undefined) levelCount[r['风险层级']]++; });

    let h = '<div class="card fade-in">' + cardHead('🏙', city + '风险总览', cityRisks.length + '个行业') + '<div class="card-bd">';
    h += '<div style="display:flex;gap:12px;margin-bottom:16px;">';
    for (const [lv, cnt] of Object.entries(levelCount)) {
      const color = lv === 'A' ? '#10b981' : lv === 'B' ? '#f59e0b' : lv === 'C' ? '#f97316' : '#ef4444';
      h += '<div style="text-align:center;padding:8px 16px;border-radius:8px;background:' + color + '11;"><div style="font-size:24px;font-weight:700;color:' + color + ';">' + cnt + '</div><div style="font-size:11px;color:#6b7280;">' + lv + '级</div></div>';
    }
    h += '</div>';
    h += '<div style="display:flex;flex-direction:column;gap:6px;">';
    cityRisks.slice(0, 20).forEach(r => {
      const color = r['风险层级'] === 'A' ? '#10b981' : r['风险层级'] === 'B' ? '#f59e0b' : r['风险层级'] === 'C' ? '#f97316' : '#ef4444';
      h += '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;">';
      h += '<span style="background:' + color + ';color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;min-width:24px;text-align:center;">' + r['风险评分'] + '</span>';
      h += '<span style="font-size:13px;">' + r['细分行业'] + '</span>';
      const adv = r['行业优势'] || '';
      h += '<span style="margin-left:auto;font-size:11px;color:#9ca3af;">' + (adv.length > 50 ? adv.substring(0, 50) + '...' : adv) + '</span>';
      h += '</div>';
    });
    h += '</div></div></div>';
    cityData[city] = h;
  });

  html += '<div id="cityOvwContent">' + (cityData[cities[0]] || '') + '</div>';

  setTimeout(() => {
    $$('.city-ovw-btn').forEach(btn => {
      btn.onclick = () => {
        $$('.city-ovw-btn').forEach(b => { b.style.fontWeight = 'normal'; b.style.background = '#fff'; });
        btn.style.fontWeight = 'bold';
        btn.style.background = '#e0f2fe';
        const content = document.getElementById('cityOvwContent');
        if (content) content.innerHTML = cityData[btn.dataset.city] || '';
      };
    });
  }, 0);

  return html;
}


// ------------------------------------------------------------------ 风险评分模型（5维度加权）
// ===== 数据解析辅助函数 =====
function parseGm(str) {
  if (!str) return null;
  var nums = str.replace(/%/g, ' ').split(/[-~至到~]/).map(function(x) { return parseFloat(x.trim()); }).filter(function(x) { return !isNaN(x); });
  return nums.length >= 2 ? { avg: (nums[0] + nums[1]) / 2, min: nums[0], max: nums[1], spread: nums[1] - nums[0] } : null;
}
function parseNpm(str) {
  if (!str) return null;
  var nums = str.replace(/%/g, ' ').split(/[-~至到~]/).map(function(x) { return parseFloat(x.trim()); }).filter(function(x) { return !isNaN(x); });
  return nums.length >= 2 ? (nums[0] + nums[1]) / 2 : null;
}
function parseSeasonMonths(str) {
  if (!str) return 0;
  if (/全年|四季|每个月/.test(str)) return 12;
  var months = [];
  var parts = str.split(/[、,，]/);
  parts.forEach(function(part) {
    var rangeMatch = part.match(/(\d+)[-~](\d+)/);
    if (rangeMatch) {
      var s = parseInt(rangeMatch[1]), e = parseInt(rangeMatch[2]);
      for (var i = s; i <= e; i++) months.push(i);
    } else {
      var singleMatch = part.match(/(\d+)/);
      if (singleMatch) months.push(parseInt(singleMatch[1]));
    }
  });
  return months.length;
}
function parseCostRatio(str, keyword) {
  if (!str) return null;
  var regex = new RegExp(keyword + '[^0-9]*(\\d+)[-~]?(\\d+)?%');
  var m = str.match(regex);
  if (m) {
    var low = parseInt(m[1]), high = m[2] ? parseInt(m[2]) : low;
    return (low + high) / 2;
  }
  return null;
}

// ===== 百分位等级阈值 =====
var _scoreCutoffs = null;
function initScoreCutoffs() {
  if (_scoreCutoffs) return _scoreCutoffs;
  var scores = [];
  for (var i = 0; i < DB.industries.length; i++) {
    try {
      var s = calcRiskScore(DB.industries[i]);
      scores.push(s.total);
    } catch(e) {}
  }
  scores.sort(function(a, b) { return a - b; });
  var n = scores.length;
  _scoreCutoffs = {
    a: scores[Math.floor(n * 0.88)] || 65,
    b: scores[Math.floor(n * 0.60)] || 52,
    c: scores[Math.floor(n * 0.25)] || 40,
    d: scores[Math.floor(n * 0.08)] || 30,
  };
  return _scoreCutoffs;
}
function getScoreLevel(score) {
  var c = _scoreCutoffs || { a: 65, b: 52, c: 40, d: 30 };
  if (score >= c.a) return 'A';
  if (score >= c.b) return 'B';
  if (score >= c.c) return 'C';
  if (score >= c.d) return 'D';
  return 'E';
}

// ===== 综合授信评分算法（5维度加权 + 门控惩罚 + 一致性奖励）=====
function calcRiskScore(ind) {
  if (!ind) return { total: 0, scores: {}, weights: {}, level: 'E' };

  var scores = { '景气度': 50, '盈利能力': 50, '稳定性': 50, '政策环境': 50, '竞争格局': 50 };

  var gm = parseGm(ind['毛利率区间']);
  var npm = parseNpm(ind['净利率区间']);
  var seasonMonths = parseSeasonMonths(ind['旺季月份']);
  var costStr = ind['成本结构'] || '';
  var rdRatio = parseCostRatio(costStr, '研发');
  var humanRatio = parseCostRatio(costStr, '人力');
  var equipRatio = parseCostRatio(costStr, '设备');
  var prospect = ind['前景趋势判断'] || '';
  var cat = ind['行业大类'] || '';
  var policy = ind['政策与外部驱动'] || '';
  var riskText = ind['主要经营风险'] || '';

  // 1. 景气度 (25%)
  if (/国家战略|战略行业/.test(prospect)) scores['景气度'] = 90;
  else if (/高速发展|朝阳|爆发|井喷|政策驱动.*高速|投资热度高|长期前景好/.test(prospect)) scores['景气度'] = 85;
  else if (/国产替代|技术迭代快|研发投入高|人才需求旺盛/.test(prospect)) scores['景气度'] = 78;
  else if (/刚需.*抗周期|稳定性.*好|稳定性最高|现金流好|基础设施.*稳定/.test(prospect)) scores['景气度'] = 68;
  else if (/人才密集|专业壁垒|客户粘性|轻资产/.test(prospect)) scores['景气度'] = 65;
  else if (/转型升级|数字化转型|产业升级|自动化|品牌化|连锁化/.test(prospect)) scores['景气度'] = 60;
  else if (/就业面广|可迁移性/.test(prospect)) scores['景气度'] = 55;
  else if (/周期性.*强|周期波动|波动大|项目制|政策敏感/.test(prospect)) scores['景气度'] = 45;
  else if (/增速放缓|下行压力|萎缩|衰退|低迷|充分竞争|薄利/.test(prospect)) scores['景气度'] = 32;
  else if (/创意密集|门槛低|入行门槛低/.test(prospect)) scores['景气度'] = 42;
  else scores['景气度'] = 50;
  if (gm) { if (gm.avg > 45) scores['景气度'] = Math.min(92, scores['景气度'] + 3); else if (gm.avg < 20) scores['景气度'] = Math.max(25, scores['景气度'] - 3); }
  if (rdRatio && rdRatio > 20) scores['景气度'] = Math.min(92, scores['景气度'] + 2);

  // 2. 盈利能力 (25%)
  var gmScore = 40, npmScore = 40;
  if (gm) {
    if (gm.avg < 15) gmScore = 15 + gm.avg * 1.0;
    else if (gm.avg < 25) gmScore = 30 + (gm.avg - 15) * 2.0;
    else if (gm.avg < 35) gmScore = 50 + (gm.avg - 25) * 1.5;
    else if (gm.avg < 45) gmScore = 65 + (gm.avg - 35) * 1.2;
    else if (gm.avg < 55) gmScore = 77 + (gm.avg - 45) * 0.8;
    else gmScore = Math.min(92, 85 + (gm.avg - 55) * 0.3);
  }
  if (npm !== null) {
    if (npm < 7) npmScore = 18 + npm * 1.5;
    else if (npm < 10) npmScore = 28 + (npm - 7) * 3.0;
    else if (npm < 13) npmScore = 37 + (npm - 10) * 2.5;
    else if (npm < 16) npmScore = 45 + (npm - 13) * 2.5;
    else if (npm < 19) npmScore = 52 + (npm - 16) * 2.5;
    else npmScore = Math.min(85, 60 + (npm - 19) * 3.0);
  }
  scores['盈利能力'] = gm ? Math.round(gmScore * 0.6 + npmScore * 0.4) : npmScore;
  if (humanRatio && humanRatio > 60) scores['盈利能力'] = Math.max(18, scores['盈利能力'] - 4);

  // 3. 稳定性 (20%)
  var stabilityBase;
  if (seasonMonths === 0) stabilityBase = 28;
  else if (seasonMonths >= 12) stabilityBase = 78;
  else if (seasonMonths >= 10) stabilityBase = 72;
  else if (seasonMonths >= 8) stabilityBase = 65;
  else if (seasonMonths >= 6) stabilityBase = 55;
  else if (seasonMonths >= 4) stabilityBase = 45;
  else if (seasonMonths >= 2) stabilityBase = 38;
  else stabilityBase = 32;
  var stableCats = ['航空航天/军工制造', '能源/矿业/石油', '政府/公共事业/非营利', '金融', '教育/培训', '医疗健庽/生物医药', '交通运输'];
  var volatileCats = ['零售/电商/消费品', '生活服务/服务业', '贸易/进出口', '广告/传媒/影视/文化/体育'];
  if (stableCats.indexOf(cat) !== -1) stabilityBase = Math.min(82, stabilityBase + 8);
  else if (volatileCats.indexOf(cat) !== -1) stabilityBase = Math.max(25, stabilityBase - 7);
  if (gm && gm.spread > 25) stabilityBase = Math.max(25, stabilityBase - 6);
  else if (gm && gm.spread < 10) stabilityBase = Math.min(82, stabilityBase + 3);
  if (/稳定|抗周期|刚需/.test(prospect)) stabilityBase = Math.min(82, stabilityBase + 4);
  else if (/波动|周期性|项目制|波动大/.test(prospect)) stabilityBase = Math.max(25, stabilityBase - 5);
  scores['稳定性'] = Math.round(stabilityBase);

  // 4. 政策环境 (20%)
  if (/政策支持|大力扶持|鼓励发展|国家战略|重点扶持|补贴|免税|减税/.test(policy)) scores['政策环境'] = 80;
  else if (/扶持|鼓励|利好|支持|促进|推动|引导发展/.test(policy)) scores['政策环境'] = 65;
  else if (/技术进步|消费升级|产业升级|数字化转型/.test(policy)) scores['政策环境'] = 58;
  else if (/行业政策|政策/.test(policy)) scores['政策环境'] = 50;
  else if (/规范|引导|优化/.test(policy)) scores['政策环境'] = 42;
  else if (/监管|限制|整治|管控|收紧|严管|趋严/.test(policy)) scores['政策环境'] = 30;
  else scores['政策环境'] = 45;
  var policySupportedCats = ['航空航天/军工制造', '新能源/环保', '医疗健庽/生物医药', '教育/培训', '农林牧渔'];
  var policyRegulatedCats = ['金融', '互联网/IT/人工智能', '房地产/建筑/工程'];
  if (policySupportedCats.indexOf(cat) !== -1) scores['政策环境'] = Math.min(85, scores['政策环境'] + 8);
  else if (policyRegulatedCats.indexOf(cat) !== -1) scores['政策环境'] = Math.max(25, scores['政策环境'] - 8);
  if (/国家战略|政策驱动|政策扶持/.test(prospect)) scores['政策环境'] = Math.min(85, scores['政策环境'] + 5);
  else if (/监管.*严|政策.*严|政策管控|政策敏感/.test(prospect)) scores['政策环境'] = Math.max(25, scores['政策环境'] - 5);

  // 5. 竞争格局 (10%)
  var highBarrierCats = ['航空航天/军工制造', '能源/矿业/石油', '金融', '电子/通信/半导体'];
  var highCompetitionCats = ['生活服务/服务业', '零售/电商/消费品', '贸易/进出口'];
  var mediumBarrierCats = ['制造业', '医疗健庽/生物医药', '新能源/环保', '汽车/出行服务', '物流/仓储/供应链', '交通运输'];
  if (highBarrierCats.indexOf(cat) !== -1) scores['竞争格局'] = 72;
  else if (highCompetitionCats.indexOf(cat) !== -1) scores['竞争格局'] = 28;
  else if (mediumBarrierCats.indexOf(cat) !== -1) scores['竞争格局'] = 50;
  else if (/垄断|壁垒高|稀缺|寡头|准入门槛|特许/.test(riskText)) scores['竞争格局'] = 68;
  else if (/差异化|品牌优势|技术优势/.test(riskText)) scores['竞争格局'] = 55;
  else {
    if (gm) { if (gm.avg >= 45) scores['竞争格局'] = 58; else if (gm.avg >= 35) scores['竞争格局'] = 48; else if (gm.avg >= 25) scores['竞争格局'] = 40; else scores['竞争格局'] = 32; }
    else scores['竞争格局'] = 42;
  }
  if (rdRatio && rdRatio > 25) scores['竞争格局'] = Math.min(80, scores['竞争格局'] + 5);
  else if (rdRatio && rdRatio > 15) scores['竞争格局'] = Math.min(78, scores['竞争格局'] + 3);
  if (humanRatio && humanRatio > 55) scores['竞争格局'] = Math.max(22, scores['竞争格局'] - 5);
  if (equipRatio && equipRatio > 15) scores['竞争格局'] = Math.min(80, scores['竞争格局'] + 3);

  // ===== 加权平均 =====
  var weights = { '景气度': 0.25, '盈利能力': 0.25, '稳定性': 0.20, '政策环境': 0.20, '竞争格局': 0.10 };
  var total = 0;
  for (var k in weights) total += scores[k] * weights[k];

  // ===== 门控罩分系统 =====
  var scoreVals = [];
  for (var k2 in scores) scoreVals.push(scores[k2]);

  // 弱项惩罚
  for (var j = 0; j < scoreVals.length; j++) {
    if (scoreVals[j] < 25) total -= 4;
    else if (scoreVals[j] < 30) total -= 2;
  }

  // 强项奖励
  var allAbove60 = scoreVals.every(function(v) { return v >= 60; });
  var allAbove65 = scoreVals.every(function(v) { return v >= 65; });
  if (allAbove65) total += 4;
  else if (allAbove60) total += 2;

  // 方差惩罚
  var avgScore = scoreVals.reduce(function(a, b) { return a + b; }, 0) / 5;
  var variance = scoreVals.reduce(function(a, b) { return a + (b - avgScore) * (b - avgScore); }, 0) / 5;
  var std = Math.sqrt(variance);
  if (std > 18) total -= 2;

  total = Math.max(15, Math.min(92, total));

  return {
    total: Math.round(total),
    scores: scores,
    weights: weights,
    level: getScoreLevel(Math.round(total))
  };
}

// ------------------------------------------------------------------ 行业差异化授信标准
function getCreditStandard(ind) {
  const score = calcRiskScore(ind);
  const lv = score.level;
  
  // 基础额度（万）
  const baseLimits = { 'A': 50, 'B': 30, 'C': 20, 'D': 10, 'E': 5 };
  // 利率区间
  const rates = { 'A': '4.5%-6%', 'B': '6%-8%', 'C': '8%-12%', 'D': '12%-18%', 'E': '18%+ 谨慎介入' };
  // 期限
  const terms = { 'A': '最长3年', 'B': '最长2年', 'C': '最长1年', 'D': '最长6个月', 'E': '不建议授信' };
  // 担保要求
  const guarantee = { 'A': '信用/弱担保', 'B': '保证/抵押', 'C': '足额抵押', 'D': '强担保+共借', 'E': '原则上拒绝' };
  // 审批权限
  const approval = { 'A': '分公司审批', 'B': '分公司审批', 'C': '总公司审批', 'D': '总公司风控会', 'E': '一律上报' };
  
  return {
    score: score.total,
    level: lv,
    baseLimit: baseLimits[lv],
    rateRange: rates[lv],
    maxTerm: terms[lv],
    guarantee: guarantee[lv],
    approval: approval[lv],
    detail: score.scores,
    weights: score.weights,
  };
}


// ------------------------------------------------------------------ 综合授信评分卡
function pageScoreCard() {
  initScoreCutoffs();
  var _sc = _scoreCutoffs || { a: 65, b: 52, c: 40, d: 30 };
  let html = `<div class="page-head">
    <div>
      <div class="page-title">综合授信评分卡</div>
      <div class="page-sub">5维度加权评分 · 输出行业授信等级与差异化策略</div>
    </div>
  </div>`;
  
  // 行业选择
  html += `<div class="section-card">
    <div style="display:flex;gap:12px;align-items:center;">
      <select id="scInd" class="input" style="max-width:300px;">
        ${DB.industries.slice(0, 30).map(i => `<option value="${esc(i['行业编号'])}">${esc(i['细分行业'])}</option>`).join('')}
      </select>
      <button class="btn btn-primary" onclick="calcScoreCard()">📊 生成评分</button>
    </div>
  </div>`;
  
  // 结果展示区
  html += `<div id="scResult" class="section-card">
    <div style="color:#94a3b8;text-align:center;padding:40px;">选择行业后点击「生成评分」查看授信评分卡</div>
  </div>`;
  
  // 评分标准说明
  html += `<div class="section-card">
    <div class="section-title">📋 评分维度说明</div>
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;">
      <div class="score-dim-card" style="border-left:3px solid #8b5cf6;">
        <div class="dim-name">景气度</div>
        <div class="dim-weight">权重 25%</div>
        <div class="dim-desc">行业生命周期阶段：爆发期/成长期/成熟期/衰退期等</div>
      </div>
      <div class="score-dim-card" style="border-left:3px solid #06b6d4;">
        <div class="dim-name">盈利能力</div>
        <div class="dim-weight">权重 25%</div>
        <div class="dim-desc">毛利率分段映射：<10%低分、10-20%中低、20-30%中等、30-40%中高、40%+高分</div>
      </div>
      <div class="score-dim-card" style="border-left:3px solid #10b981;">
        <div class="dim-name">经营稳定性</div>
        <div class="dim-weight">权重 20%</div>
        <div class="dim-desc">旺季月份分布：4-7个月最稳定，过少或过多均扣分</div>
      </div>
      <div class="score-dim-card" style="border-left:3px solid #f59e0b;">
        <div class="dim-name">政策环境</div>
        <div class="dim-weight">权重 20%</div>
        <div class="dim-desc">政策支持/监管力度：扶持类加分、监管限制类减分</div>
      </div>
      <div class="score-dim-card" style="border-left:3px solid #ef4444;">
        <div class="dim-name">竞争格局</div>
        <div class="dim-weight">权重 10%</div>
        <div class="dim-desc">竞争激烈度反向打分：红海/价格战低分、垄断/壁垒高高分</div>
      </div>
    </div>
  </div>`;
  
  // 行业综合授信分分布
  html += `<div class="section-card">
    <div class="section-title">📊 全行业综合授信分分布</div>
    <div id="scDistChart">
      <div style="color:#94a3b8;text-align:center;padding:20px;">加载中...</div>
    </div>
    <p class="hint" style="margin-top:10px;">统计全部 ${DB.industries.length} 个细分行业的综合授信评分分布，点击柱状图可跳转查看对应行业。</p>
  </div>`;
  
  // 差异化授信标准表
  html += `<div class="section-card">
    <div class="section-title">🏦 行业差异化授信标准</div>
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px;">
      <div class="credit-lv-card" style="border-top:3px solid #10b981;">
        <div class="clv-badge" style="background:#d1fae5;color:#059669;">A 级</div>
        <div class="clv-score">${_sc.a} 分以上</div>
        <div class="clv-item"><span>基础额度</span><b>50 万</b></div>
        <div class="clv-item"><span>参考利率</span><b>4.5% - 6%</b></div>
        <div class="clv-item"><span>最长期限</span><b>3 年</b></div>
        <div class="clv-item"><span>担保要求</span><b>信用/弱担保</b></div>
        <div class="clv-item"><span>审批权限</span><b>分公司审批</b></div>
      </div>
      <div class="credit-lv-card" style="border-top:3px solid #3b82f6;">
        <div class="clv-badge" style="background:#dbeafe;color:#2563eb;">B 级</div>
        <div class="clv-score">${_sc.b} - ${_sc.a - 1} 分</div>
        <div class="clv-item"><span>基础额度</span><b>30 万</b></div>
        <div class="clv-item"><span>参考利率</span><b>6% - 8%</b></div>
        <div class="clv-item"><span>最长期限</span><b>2 年</b></div>
        <div class="clv-item"><span>担保要求</span><b>保证/抵押</b></div>
        <div class="clv-item"><span>审批权限</span><b>分公司审批</b></div>
      </div>
      <div class="credit-lv-card" style="border-top:3px solid #f59e0b;">
        <div class="clv-badge" style="background:#fef3c7;color:#d97706;">C 级</div>
        <div class="clv-score">${_sc.c} - ${_sc.b - 1} 分</div>
        <div class="clv-item"><span>基础额度</span><b>20 万</b></div>
        <div class="clv-item"><span>参考利率</span><b>8% - 12%</b></div>
        <div class="clv-item"><span>最长期限</span><b>1 年</b></div>
        <div class="clv-item"><span>担保要求</span><b>足额抵押</b></div>
        <div class="clv-item"><span>审批权限</span><b>总公司审批</b></div>
      </div>
      <div class="credit-lv-card" style="border-top:3px solid #f97316;">
        <div class="clv-badge" style="background:#ffedd5;color:#ea580c;">D 级</div>
        <div class="clv-score">${_sc.d} - ${_sc.c - 1} 分</div>
        <div class="clv-item"><span>基础额度</span><b>10 万</b></div>
        <div class="clv-item"><span>参考利率</span><b>12% - 18%</b></div>
        <div class="clv-item"><span>最长期限</span><b>6 个月</b></div>
        <div class="clv-item"><span>担保要求</span><b>强担保+共借</b></div>
        <div class="clv-item"><span>审批权限</span><b>总公司风控会</b></div>
      </div>
      <div class="credit-lv-card" style="border-top:3px solid #ef4444;">
        <div class="clv-badge" style="background:#fee2e2;color:#dc2626;">E 级</div>
        <div class="clv-score">低于 ${_sc.d} 分</div>
        <div class="clv-item"><span>基础额度</span><b>5 万</b></div>
        <div class="clv-item"><span>参考利率</span><b>18%+ 谨慎</b></div>
        <div class="clv-item"><span>最长期限</span><b>不建议</b></div>
        <div class="clv-item"><span>担保要求</span><b>原则上拒绝</b></div>
        <div class="clv-item"><span>审批权限</span><b>一律上报</b></div>
      </div>
    </div>
    <div class="hint" style="margin-top:10px;padding:12px 16px;background:#fff7ed;border-radius:8px;border-left:3px solid #f97316;font-size:13px;color:#9a3412;">
      <b>⚠ 温馨提示：</b>以上为行业基准额度，实际授信需结合借款人资质、担保条件、还款能力、经营稳定性等因素综合判断，本评分卡仅供参考。
    </div>
  </div>`;
  
  setTimeout(() => {
    const sel = document.getElementById('scInd');
    if (sel) {
      // 默认选第一个并计算
      calcScoreCard();
    }
    // 渲染行业分布
    initScoreCutoffs();
  renderScoreDist();
  }, 100);
  
  return html;
}

function calcScoreCard() {
  const code = document.getElementById('scInd').value;
  const ind = DB.industries.find(i => i['行业编号'] === code);
  if (!ind) return;
  
  const std = getCreditStandard(ind);
  const levelColors = {
    'A': { bg: '#d1fae5', fg: '#059669', bar: '#10b981' },
    'B': { bg: '#dbeafe', fg: '#2563eb', bar: '#3b82f6' },
    'C': { bg: '#fef3c7', fg: '#d97706', bar: '#f59e0b' },
    'D': { bg: '#ffedd5', fg: '#ea580c', bar: '#f97316' },
    'E': { bg: '#fee2e2', fg: '#dc2626', bar: '#ef4444' },
  };
  const c = levelColors[std.level] || levelColors['C'];
  
  let dimensionsHtml = '';
  for (const dim in std.detail) {
    const val = std.detail[dim];
    const weight = Math.round(std.weights[dim] * 100);
    dimensionsHtml += `<div style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
        <span style="color:#475569;">${dim} <span style="color:#94a3b8;">(${weight}%)</span></span>
        <span style="font-weight:600;color:${c.bar};">${val}分</span>
      </div>
      <div style="height:8px;background:#f1f5f9;border-radius:4px;overflow:hidden;">
        <div style="height:100%;width:${val}%;background:${c.bar};transition:width .5s;"></div>
      </div>
    </div>`;
  }
  
  document.getElementById('scResult').innerHTML = `
    <div style="display:grid;grid-template-columns:280px 1fr;gap:24px;align-items:start;">
      <div style="text-align:center;padding:20px;background:${c.bg};border-radius:12px;">
        <div style="font-size:13px;color:${c.fg};margin-bottom:8px;">综合授信评分</div>
        <div style="font-size:48px;font-weight:800;color:${c.fg};line-height:1;">${std.score}</div>
        <div style="margin-top:8px;"><span class="lv-tag" style="background:${c.bg};color:${c.fg};font-size:16px;padding:4px 16px;">${std.level} 级</span></div>
        <div style="font-size:12px;color:${c.fg};opacity:.7;margin-top:8px;">${esc(ind['细分行业'])}</div>
      </div>
      <div>
        <div class="section-title" style="margin-top:0;">5维度评分明细</div>
        ${dimensionsHtml}
      </div>
    </div>
    
    <div style="margin-top:20px;padding-top:20px;border-top:1px solid #e2e8f0;">
      <div class="section-title">差异化授信策略</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px;">
        <div style="background:#f8fafc;padding:12px;border-radius:8px;text-align:center;">
          <div style="font-size:12px;color:#64748b;margin-bottom:4px;">基础额度</div>
          <div style="font-size:20px;font-weight:700;color:#0f172a;">${std.baseLimit}万</div>
        </div>
        <div style="background:#f8fafc;padding:12px;border-radius:8px;text-align:center;">
          <div style="font-size:12px;color:#64748b;margin-bottom:4px;">参考利率</div>
          <div style="font-size:16px;font-weight:700;color:#0f172a;">${std.rateRange}</div>
        </div>
        <div style="background:#f8fafc;padding:12px;border-radius:8px;text-align:center;">
          <div style="font-size:12px;color:#64748b;margin-bottom:4px;">最长期限</div>
          <div style="font-size:16px;font-weight:700;color:#0f172a;">${std.maxTerm}</div>
        </div>
        <div style="background:#f8fafc;padding:12px;border-radius:8px;text-align:center;">
          <div style="font-size:12px;color:#64748b;margin-bottom:4px;">担保要求</div>
          <div style="font-size:13px;font-weight:600;color:#0f172a;">${std.guarantee}</div>
        </div>
      </div>
      <div style="margin-top:12px;padding:10px 14px;background:#eff6ff;border-radius:6px;font-size:13px;color:#1e40af;">
        <b>审批权限：</b>${std.approval}
      </div>
    </div>
  `;
}

// 渲染全行业综合授信分分布图
function renderScoreDist() {
  var container = document.getElementById('scDistChart');
  if (!container) return;

  initScoreCutoffs();
  var cutoffs = _scoreCutoffs;

  // 计算所有行业的评分
  var allScores = [];
  for (var i = 0; i < DB.industries.length; i++) {
    var ind = DB.industries[i];
    try {
      var std = getCreditStandard(ind);
      allScores.push({ code: ind['行业编号'], name: ind['细分行业'], score: std.score, level: std.level });
    } catch(e) {}
  }

  if (!allScores.length) {
    container.innerHTML = '<p class="hint">暂无数据</p>';
    return;
  }

  // 按百分位区间统计
  var ranges = [
    { label: 'A级 (' + cutoffs.a + '+)', min: cutoffs.a, max: 100, color: '#10b981', bg: '#d1fae5', count: 0, items: [] },
    { label: 'B级 (' + cutoffs.b + '-' + (cutoffs.a - 1) + ')', min: cutoffs.b, max: cutoffs.a - 1, color: '#3b82f6', bg: '#dbeafe', count: 0, items: [] },
    { label: 'C级 (' + cutoffs.c + '-' + (cutoffs.b - 1) + ')', min: cutoffs.c, max: cutoffs.b - 1, color: '#f59e0b', bg: '#fef3c7', count: 0, items: [] },
    { label: 'D级 (' + cutoffs.d + '-' + (cutoffs.c - 1) + ')', min: cutoffs.d, max: cutoffs.c - 1, color: '#f97316', bg: '#ffedd5', count: 0, items: [] },
    { label: 'E级 (<' + cutoffs.d + ')', min: 0, max: cutoffs.d - 1, color: '#ef4444', bg: '#fee2e2', count: 0, items: [] },
  ];

  allScores.forEach(function(s) {
    for (var r = 0; r < ranges.length; r++) {
      if (s.score >= ranges[r].min && s.score <= ranges[r].max) {
        ranges[r].count++;
        ranges[r].items.push(s);
        break;
      }
    }
  });

  var maxCount = Math.max.apply(null, ranges.map(function(r) { return r.count; }).concat([1]));
  var total = allScores.length;

  var html = '<div style="display:flex;align-items:flex-end;gap:16px;height:240px;padding:0 10px 10px;border-bottom:1px solid #e2e8f0;">';
  ranges.forEach(function(r, i) {
    var barH = r.count > 0 ? Math.max((r.count / maxCount * 180), 8) : 2;
    var pct = ((r.count / total) * 100).toFixed(1);
    html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;cursor:pointer;height:100%;justify-content:flex-end;" onmouseover="this.style.opacity=.85" onmouseout="this.style.opacity=1" onclick="showScDistDetail(' + i + ')">' +
      '<div style="font-size:12px;font-weight:600;color:' + r.color + ';margin-bottom:4px;">' + r.count + ' 个 (' + pct + '%)</div>' +
      '<div style="width:70%;height:' + barH + 'px;background:linear-gradient(180deg,' + r.color + 'cc,' + r.color + ');border-radius:8px 8px 0 0;transition:height .5s;"></div>' +
      '<div style="margin-top:8px;padding:2px 8px;background:' + r.bg + ';color:' + r.color + ';border-radius:4px;font-size:12px;font-weight:600;">' + r.label + '</div>' +
    '</div>';
  });
  html += '</div>';

  // 更新信用标准表的分数范围
  var lvCards = document.querySelectorAll('.credit-lv-card');
  if (lvCards.length >= 5) {
    var labels = [
      cutoffs.a + ' 分以上',
      cutoffs.b + ' - ' + (cutoffs.a - 1) + ' 分',
      cutoffs.c + ' - ' + (cutoffs.b - 1) + ' 分',
      cutoffs.d + ' - ' + (cutoffs.c - 1) + ' 分',
      '低于 ' + cutoffs.d + ' 分'
    ];
    var scoreEls = document.querySelectorAll('.clv-score');
    scoreEls.forEach(function(el, i) {
      if (labels[i]) el.textContent = labels[i];
    });
  }

  container.innerHTML = html;
  window._scDistData = ranges;
}

function showScDistDetail(idx) {
  const detailEl = document.getElementById('scDistDetail');
  if (!detailEl || !window._scDistData) return;
  
  const r = window._scDistData[idx];
  if (!r || !r.items.length) return;
  
  // 按分数降序排序
  const sorted = r.items.slice().sort((a, b) => b.score - a.score);
  
  let html = `<div style="font-weight:600;color:${r.color};margin-bottom:10px;font-size:14px;">${r.label} · 共 ${r.count} 个行业（按分数从高到低）</div>`;
  html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
  sorted.forEach(s => {
    html += `<span class="tag sm" style="background:#fff;border:1px solid ${r.color}30;color:#334155;cursor:pointer;padding:4px 10px;"
              onclick="jumpToScIndustry('${esc(s.code)}')" title="点击查看详情">
      ${esc(s.name)} <b style="color:${r.color};">${s.score}</b>
    </span>`;
  });
  html += '</div>';
  
  detailEl.style.cssText = 'margin-top:16px;padding:14px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;';
  detailEl.innerHTML = html;
}

function jumpToScIndustry(code) {
  const sel = document.getElementById('scInd');
  if (sel) {
    sel.value = code;
    calcScoreCard();
    // 滚动到结果区
    const result = document.getElementById('scResult');
    if (result) result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}


// ------------------------------------------------------------------ 行业景气度趋势分析
function calcProsperityScore(ind) {
  if (!ind) return 3;
  
  let score = 3; // 中等
  
  // 基于周期标签
  const cycle = ind.cycleTag || '';
  if (cycle === '爆发期') score = 5;
  else if (cycle === '成长期') score = 4;
  else if (cycle === '政策驱动期') score = 4;
  else if (cycle === '稳定期') score = 3;
  else if (cycle === '成熟期') score = 2.5;
  else if (cycle === '衰退期') score = 1.5;
  
  // 基于毛利率微调
  const gmStr = ind['毛利率区间'] || '';
  const gmMatch = gmStr.match(/(\d+)\s*%?\s*[-~至]\s*(\d+)/);
  if (gmMatch) {
    const avgGm = (parseInt(gmMatch[1]) + parseInt(gmMatch[2])) / 2;
    if (avgGm > 40) score = Math.min(5, score + 0.5);
    else if (avgGm < 15) score = Math.max(1, score - 0.5);
  }
  
  return Math.round(score * 10) / 10;
}

function renderProsperityStars(score) {
  const full = Math.floor(score);
  const half = score - full >= 0.5;
  let stars = '';
  for (let i = 0; i < full; i++) stars += '★';
  if (half) stars += '☆';
  for (let i = 0; i < 5 - full - (half ? 1 : 0); i++) stars += '☆';
  return `<span style="color:#f59e0b;letter-spacing:2px;">${stars}</span> <span style="color:#64748b;font-size:13px;">${score}</span>`;
}


// ------------------------------------------------------------------ 电核助手
function pageInterview() {
  let html = `<div class="page-head">
    <div>
      <div class="page-title">电核助手</div>
      <div class="page-sub">选择岗位，获取标准化访谈问题与破绽识别要点</div>
    </div>
  </div>`;
  
  // 岗位搜索
  html += `<div class="section-card">
    <div style="display:flex;gap:12px;align-items:center;">
      <input id="intvSearch" class="input" placeholder="输入岗位名称或拼音搜索..." style="flex:1;" />
      <button class="btn btn-primary" onclick="doInterviewSearch()">搜索</button>
    </div>
    <div id="intvResults" style="margin-top:16px;"></div>
  </div>`;
  
  // 访谈要点
  html += `<div class="section-card" id="intvDetail" style="display:none;">
    <div class="section-title">访谈详情</div>
    <div id="intvDetailContent"></div>
  </div>`;
  
  // 通用电核技巧
  html += `<div class="section-card">
    <div class="section-title">💡 通用电核技巧</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div style="background:#f0fdf4;padding:12px 16px;border-radius:8px;border-left:4px solid #22c55e;">
        <div style="font-weight:600;color:#15803d;margin-bottom:6px;">✅ 正确做法</div>
        <ul style="margin:0;padding-left:18px;color:#166534;font-size:13px;line-height:1.9;">
          <li>开放式问题为主，避免Yes/No</li>
          <li>追问具体数字、时间、人名</li>
          <li>注意回答速度与语气变化</li>
          <li>交叉验证不同渠道信息</li>
          <li>做好录音与文字记录</li>
        </ul>
      </div>
      <div style="background:#fef2f2;padding:12px 16px;border-radius:8px;border-left:4px solid #ef4444;">
        <div style="font-weight:600;color:#b91c1c;margin-bottom:6px;">❌ 常见误区</div>
        <ul style="margin:0;padding-left:18px;color:#991b1b;font-size:13px;line-height:1.9;">
          <li>诱导性提问（"你是做Java的吧？"）</li>
          <li>只核对职位名称不深挖内容</li>
          <li>对方犹豫时主动给台阶</li>
          <li>忽略语气、语速等非语言信号</li>
          <li>一次问太多问题记不住</li>
        </ul>
      </div>
    </div>
  </div>`;
  
  setTimeout(() => {
    const input = document.getElementById('intvSearch');
    if (input) {
      input.addEventListener('keydown', e => { if (e.key === 'Enter') doInterviewSearch(); });
    }
  }, 0);
  
  return html;
}

function doInterviewSearch() {
  const kw = document.getElementById('intvSearch').value.trim();
  const results = searchByIndex(kw, 'jobs').slice(0, 10);
  const container = document.getElementById('intvResults');
  
  if (!results.length) {
    container.innerHTML = '<div style="color:#94a3b8;text-align:center;padding:20px;">未找到相关岗位</div>';
    return;
  }
  
  let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">';
  results.forEach(job => {
    html += `<div class="job-item" onclick="showInterviewDetail('${esc(job['职位编号'])}')" style="cursor:pointer;">
      <div style="font-weight:600;">${esc(job['常见职位'])}</div>
      <div style="font-size:12px;color:#64748b;">${esc(job['行业大类'])} · ${esc(job['细分行业'])}</div>
    </div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

function showInterviewDetail(jobId) {
  const job = DB.jobs.find(j => j['职位编号'] === jobId);
  if (!job) return;
  
  document.getElementById('intvDetail').style.display = 'block';
  const content = document.getElementById('intvDetailContent');
  
  // 获取岗位对应的反欺诈要点
  const fraudTips = getFraudTipsForJob(job);
  
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
      <div>
        <h3 style="margin:0 0 4px;">${esc(job['常见职位'])}</h3>
        <div style="font-size:13px;color:#64748b;">${esc(job['行业大类'])} / ${esc(job['细分行业'])}</div>
      </div>
      <div style="display:flex;gap:8px;">
         <button class="btn sm" onclick="toggleCmpJob('${esc(job['职位编号'])}','${esc(job['行业编号'])}','${esc(job['常见职位'])}')">⚖️ 加入对比</button>
       </div>
    </div>
    
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div class="detail-block">
        <div class="detail-label">🎙 审核时怎么问</div>
        <div class="detail-value" style="white-space:pre-wrap;">${esc(job['审核时怎么问'] || '')}</div>
      </div>
      <div class="detail-block">
        <div class="detail-label">🔍 能查到哪些证据</div>
        <div class="detail-value" style="white-space:pre-wrap;">${esc(job['能查到哪些证据'] || '')}</div>
      </div>
      <div class="detail-block" style="background:#f0fdf4;">
        <div class="detail-label" style="color:#15803d;">✅ 真干过的人怎么答</div>
        <div class="detail-value" style="white-space:pre-wrap;color:#166534;">${esc(job['真干过的人怎么答'] || '')}</div>
      </div>
      <div class="detail-block" style="background:#fef2f2;">
        <div class="detail-label" style="color:#b91c1c;">⚠ 没干过的破绽</div>
        <div class="detail-value" style="white-space:pre-wrap;color:#991b1b;">${esc(job['没干过的破绽'] || '')}</div>
      </div>
    </div>
    
    <div class="detail-block" style="margin-top:16px;background:#eff6ff;">
      <div class="detail-label" style="color:#1d4ed8;">📌 审批要点</div>
      <div class="detail-value" style="white-space:pre-wrap;color:#1e40af;">${esc(job['审批要点'] || '')}</div>
    </div>
    
    <div class="fraud-block">
      <div class="fraud-label">🎭 反欺诈识别要点</div>
      <div class="fraud-subtitle">常见造假方式：</div>
      <ul>${fraudTips.methods.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
      <div class="fraud-subtitle">识别技巧：</div>
      <ul>${fraudTips.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      ${fraudTips.redFlags.length ? `
      <div class="fraud-subtitle">🚩 高危信号（出现即需重点核查）：</div>
      <ul>${fraudTips.redFlags.map(r => `<li class="fraud-redflag">${esc(r)}</li>`).join('')}</ul>` : ''}
    </div>
  `;
}

// ---- 反欺诈知识库
const FRAUD_KNOWLEDGE = {
  // 通用造假手段
  common: {
    methods: [
      '伪造银行流水（PS、购买假流水、自己账户互转）',
      '虚假工作证明（私刻公章、朋友公司挂靠）',
      '社保代缴（第三方公司代缴，非真实用工）',
      '虚假学历证书（伪造毕业证、学位证）',
      '虚报收入（实际工资5千报1万）',
      '虚构工作经历（时间、职位、公司造假）',
    ],
    tips: [
      '流水验证：查银行APP截图完整性、交易对手合理性、工资发放日期规律',
      '工作验证：拨打公司固话核实、企查查比对法人/股东、查社保缴费单位',
      '收入验证：个税APP截图、公积金缴费基数推算、银行卡入账明细',
      '逻辑验证：工作年限与收入水平是否匹配、行业薪资范围是否合理',
      '交叉验证：不同渠道获取的信息是否一致（流水vs社保vs口述）',
    ],
    redFlags: [
      '只能提供微信转账记录，无法提供银行流水',
      '工资以现金发放，无任何银行入账记录',
      '社保缴费基数远低于声称的收入水平',
      '入职时间短（<3个月）且收入异常高',
      '无法提供公司固话，只能提供手机号',
    ]
  },
  // 按岗位类别细分
  categories: {
    'IT|程序员|开发|工程师|技术': {
      methods: [
        '简历注水（虚构项目经验、夸大技术栈）',
        '培训机构包装（0基础包装成2年经验）',
        '代做笔试题/面试作弊',
        '虚报薪资（IT行业水分大，虚报30%-50%很常见）',
      ],
      tips: [
        '技术深度追问：问具体技术细节、遇到的问题及解决方案',
        'GitHub/技术博客验证：看代码提交记录、技术文章质量',
        '薪资验证：IT行业薪资透明度高，可对照行业薪酬报告',
        '项目验证：问项目架构、团队规模、个人职责、上线时间',
      ],
      redFlags: [
        '工作年限短但薪资远超同年限正常水平',
        '简历上全是热门技术但深入问都不会',
        '说不出具体项目的技术难点和解决方案',
      ]
    },
    '销售|业务|客户经理': {
      methods: [
        '虚报业绩（把团队业绩算成个人的）',
        '虚构客户资源',
        '隐瞒真实收入（提成部分无法核实）',
        '频繁跳槽，每份工作都不到1年',
      ],
      tips: [
        '业绩核实：问具体客户名称、合同金额、回款周期',
        '收入核实：提成部分看银行入账备注、个税申报',
        '稳定性评估：看过往工作经历稳定性，频繁跳槽风险高',
        '客户验证：可要求提供1-2个客户联系人核实',
      ],
      redFlags: [
        '声称月入数万但流水都是零散转账',
        '每份工作都不到6个月且理由都是"公司倒闭"',
        '说不出任何一个客户的具体名称和联系方式',
      ]
    },
    '餐饮|厨师|服务员|店长': {
      methods: [
        '虚报工资（餐饮行业现金多，流水不好查）',
        '虚构管理经验（普通厨师包装成厨师长/店长）',
        '挂靠餐厅开工作证明',
      ],
      tips: [
        '实地考察：上门看工作环境、和同事聊天核实',
        '技能验证：厨师可要求现场展示刀工/炒菜',
        '管理验证：问排班表、成本控制、员工人数等细节',
        '工资验证：看工资条、微信/支付宝转账记录规律',
      ],
      redFlags: [
        '声称是店长但不知道店铺面积和员工人数',
        '工资全部现金发放，无任何转账记录',
        '提供的餐厅电话打不通或无人接听',
      ]
    },
    '美容|美发|美甲|健身': {
      methods: [
        '虚报业绩和提成',
        '虚构工作年限和技术等级',
        '挂靠门店开证明',
      ],
      tips: [
        '技能验证：要求看作品照片、客户评价',
        '收入验证：看提成明细、客户充值记录',
        '门店验证：企查查查门店状态、大众点评看评价',
      ],
      redFlags: [
        '声称月薪2万以上但无任何银行入账记录',
        '说不出门店的具体项目价格和会员制度',
        '工作地点频繁更换，每个地方都不到半年',
      ]
    },
    '司机|货运|快递|外卖': {
      methods: [
        '虚构货运/快递从业经验',
        '虚报收入（平台收入可截图但可能P图）',
        '车辆不是本人名下（租车/借车）',
      ],
      tips: [
        '平台验证：登录平台APP看历史订单、收入明细',
        '车辆验证：查行驶证、车辆登记证、保险投保人',
        '经验验证：问路线、油耗、过路费、平台规则等细节',
        '流水验证：看平台提现记录、绑定银行卡入账',
      ],
      redFlags: [
        '只能提供收入截图，不能登录APP实时查看',
        '车辆行驶证不是本人名下且无法提供租赁合同',
        '说不出平台的抽成比例和提现规则',
      ]
    },
    '财务|会计|出纳': {
      methods: [
        '虚构财务工作经历（出纳包装成总账会计）',
        '虚报证书（初级包装成中级/CPA）',
        '挂靠公司开工作证明',
      ],
      tips: [
        '专业验证：问具体账务处理、税务申报、报表编制细节',
        '证书验证：在财政部官网查会计职称证书编号',
        '经验验证：问用过哪些财务软件、做过哪些税种申报',
      ],
      redFlags: [
        '声称是总账会计但说不出增值税申报流程',
        '有中级证但连基本会计分录都写错',
        '说不出金蝶/用友等常用财务软件的基本操作',
      ]
    },
    '行政|人事|HR|文员': {
      methods: [
        '虚构管理经验（文员包装成行政主管/HR经理）',
        '虚报薪资（行政岗位薪资普遍不高，虚报空间大）',
        '挂靠小公司开证明',
      ],
      tips: [
        '职责验证：问具体工作内容、公司架构、汇报关系',
        '专业验证：HR岗位问招聘渠道、绩效考核、社保公积金基数',
        '逻辑验证：公司规模与行政/HR人数配比是否合理',
      ],
      redFlags: [
        '声称是HR经理但说不出招聘渠道和成本',
        '10人以下公司声称有专门的HR主管',
        '说不出公司具体的组织架构和部门设置',
      ]
    },
    '设计|美工|UI|平面': {
      methods: [
        '简历放别人的作品（盗图、下载模板）',
        '虚构工作经验（培训包装）',
        '虚报薪资和级别',
      ],
      tips: [
        '作品验证：问设计思路、用什么软件、花了多长时间',
        '技能验证：现场上机操作（PS/AI/Figma）',
        '作品集验证：看设计风格是否统一、有无源文件',
      ],
      redFlags: [
        '作品集风格差异很大，明显不是同一个人做的',
        '说不出自己作品的设计理念和思考过程',
        '声称是资深设计师但软件操作不熟练',
      ]
    },
  }
};

// 根据岗位匹配反欺诈要点
function getFraudTipsForJob(job) {
  const jobName = job['常见职位'] || '';
  const cat = job['行业大类'] || '';
  const fullText = jobName + cat;
  
  let result = {
    methods: [...FRAUD_KNOWLEDGE.common.methods],
    tips: [...FRAUD_KNOWLEDGE.common.tips],
    redFlags: [...FRAUD_KNOWLEDGE.common.redFlags]
  };
  
  // 匹配岗位类别
  for (const pattern in FRAUD_KNOWLEDGE.categories) {
    if (new RegExp(pattern).test(fullText)) {
      const catData = FRAUD_KNOWLEDGE.categories[pattern];
      result.methods = [...catData.methods, ...result.methods.slice(0, 2)];
      result.tips = [...catData.tips, ...result.tips.slice(0, 2)];
      result.redFlags = [...result.redFlags, ...catData.redFlags];
      break;
    }
  }
  
  return result;
}


// ------------------------------------------------------------------ 额度计算器
function pageCalculator() {
  let html = `<div class="page-head">
    <div>
      <div class="page-title">额度计算器</div>
      <div class="page-sub">根据收入、负债、行业风险等因素测算预估额度</div>
    </div>
  </div>`;
  
  html += `<div class="section-card">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
      <div>
        <h4 style="margin:0 0 12px;color:#0f172a;">基本信息</h4>
        <div class="form-row">
          <label>月收入（元）</label>
          <input id="calcIncome" class="input" type="number" value="10000" placeholder="请输入月收入" />
        </div>
        <div class="form-row">
          <label>月负债支出（元）</label>
          <input id="calcDebt" class="input" type="number" value="2000" placeholder="房贷/车贷/其他" />
        </div>
        <div class="form-row">
          <label>工作年限（年）</label>
          <input id="calcYears" class="input" type="number" value="3" placeholder="本单位工作年限" />
        </div>
        <div class="form-row">
          <label>所在城市</label>
          <select id="calcCity" class="input">
            ${DB.cities.slice(0, 30).map(c => {
              const name = c['城市名称'] || c['城市'] || String(c);
              return `<option value="${esc(name)}">${esc(name)}</option>`;
            }).join('')}
          </select>
        </div>
        <div class="form-row">
          <label>行业</label>
          <select id="calcInd" class="input">
            ${DB.industries.slice(0, 20).map(i => `<option value="${esc(i['行业编号'])}">${esc(i['细分行业'])}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary" style="width:100%;margin-top:8px;" onclick="calcLoan()">📊 开始测算</button>
      </div>
      <div id="calcResult" style="background:#f8fafc;border-radius:8px;padding:20px;min-height:300px;">
        <div style="color:#94a3b8;text-align:center;line-height:260px;">请填写左侧信息后点击测算</div>
      </div>
    </div>
  </div>`;
  
  // 说明
  html += `<div class="section-card">
    <div class="section-title">📋 测算说明</div>
    <ul style="margin:0;padding-left:20px;color:#475569;font-size:13px;line-height:2;">
      <li><b>收入认定：</b>月收入 × 收入认定系数（受行业风险影响）</li>
      <li><b>负债比：</b>月负债 / 月认定收入，建议不超过 50%</li>
      <li><b>额度公式：</b>(月收入 - 月负债) × 12 × 行业系数 × 城市系数</li>
      <li><b>风险调整：</b>高风险行业下调 20-40%，低风险行业上浮 10-20%</li>
      <li style="color:#ef4444;">⚠ 测算结果仅供参考，实际额度以最终审批为准</li>
    </ul>
  </div>`;
  
  return html;
}

function calcLoan() {
  const income = Number(document.getElementById('calcIncome').value) || 0;
  const debt = Number(document.getElementById('calcDebt').value) || 0;
  const years = Number(document.getElementById('calcYears').value) || 0;
  const city = document.getElementById('calcCity').value;
  const indCode = document.getElementById('calcInd').value;
  
  const ind = DB.industries.find(i => i['行业编号'] === indCode);
  
  // 行业风险系数
  let riskCoef = 1.0;
  const riskLv = (ind && ind['风险等级']) || '中等';
  if (/低风险|极低|A|B/.test(riskLv)) riskCoef = 1.2;
  else if (/中低|C/.test(riskLv)) riskCoef = 1.1;
  else if (/中等|中/.test(riskLv)) riskCoef = 1.0;
  else if (/中高|较高|D/.test(riskLv)) riskCoef = 0.8;
  else if (/高风险|极高|E/.test(riskLv)) riskCoef = 0.6;
  
  // 城市系数
  let cityCoef = 1.0;
  if (/北京|上海|深圳|广州/.test(city)) cityCoef = 1.2;
  else if (/杭州|南京|苏州|成都|武汉|重庆|西安/.test(city)) cityCoef = 1.1;
  
  // 工龄系数
  let yearsCoef = 0.7;
  if (years >= 5) yearsCoef = 1.1;
  else if (years >= 3) yearsCoef = 1.0;
  else if (years >= 1) yearsCoef = 0.9;
  else if (years >= 0.5) yearsCoef = 0.8;
  
  const netIncome = income - debt;
  const yearlyNet = netIncome * 12;
  const maxLoan = Math.round(yearlyNet * riskCoef * cityCoef * yearsCoef);
  const minLoan = Math.round(maxLoan * 0.6);
  const dti = income > 0 ? Math.round(debt / income * 100) : 0;
  
  const result = document.getElementById('calcResult');
  result.innerHTML = `
    <h3 style="margin:0 0 16px;color:#0f172a;">测算结果</h3>
    <div style="text-align:center;padding:20px 0;background:linear-gradient(135deg,#3b82f6,#8b5cf6);border-radius:8px;color:#fff;margin-bottom:16px;">
      <div style="font-size:13px;opacity:.9;">预估额度范围</div>
      <div style="font-size:32px;font-weight:700;">${(minLoan/10000).toFixed(1)} ~ ${(maxLoan/10000).toFixed(1)} 万</div>
      <div style="font-size:12px;opacity:.8;margin-top:4px;">即 ${minLoan.toLocaleString()} ~ ${maxLoan.toLocaleString()} 元</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px;">
      <div style="background:#fff;padding:10px;border-radius:6px;">
        <div style="color:#64748b;">月净收入</div>
        <div style="font-weight:600;color:#0f172a;">${netIncome.toLocaleString()} 元</div>
      </div>
      <div style="background:#fff;padding:10px;border-radius:6px;">
        <div style="color:#64748b;">负债收入比</div>
        <div style="font-weight:600;color:${dti > 50 ? '#ef4444' : '#22c55e'};">${dti}% ${dti > 50 ? '⚠' : '✓'}</div>
      </div>
      <div style="background:#fff;padding:10px;border-radius:6px;">
        <div style="color:#64748b;">行业风险系数</div>
        <div style="font-weight:600;color:#0f172a;">${riskCoef.toFixed(2)} (${esc(riskLv)})</div>
      </div>
      <div style="background:#fff;padding:10px;border-radius:6px;">
        <div style="color:#64748b;">城市+工龄系数</div>
        <div style="font-weight:600;color:#0f172a;">${(cityCoef * yearsCoef).toFixed(2)}</div>
      </div>
    </div>
    <div style="margin-top:12px;padding:10px;background:#fef3c7;border-radius:6px;font-size:12px;color:#92400e;">
      💡 建议：${dti > 50 ? '当前负债偏高，建议降低负债后再申请' : netIncome < 3000 ? '月净收入较低，建议补充其他收入证明' : '资质良好，可正常申请，注意核实收入真实性'}
    </div>
  `;
}


// ------------------------------------------------------------------ 主题切换
function applyTheme() {
  const theme = S.theme || 'light';
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = theme === 'dark' ? '☀️ 亮色' : '🌙 暗色';
}

function toggleTheme() {
  S.theme = S.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('xwk_theme_v4', S.theme);
  applyTheme();
}


// ------------------------------------------------------------------ 城市投资吸引力排名
function pageCityRank() {
  const cities = DB.cities || [];
  const risks = DB.city_risks || [];
  
  // 计算综合吸引力得分
  const ranked = cities.map(city => {
    const name = city['城市名称'] || city.name || String(city);
    const salaryCoef = parseFloat(city['薪资系数']) || 0.7;
    const ecoLevel = parseFloat(city['经济水平']) || 6;
    
    // 找风险数据（用for循环避免箭头函数问题）
    let risk = null;
    for (let k = 0; k < risks.length; k++) {
      if (risks[k]['城市'] === name) { risk = risks[k]; break; }
    }
    
    let riskScore = 50;
    let riskLv = 'C';
    if (risk) {
      try {
        riskLv = normLv(risk['风险层级']) || 'C';
        riskScore = 80 - (riskLv === 'A' ? 10 : riskLv === 'B' ? 25 : riskLv === 'C' ? 45 : 65);
      } catch(e) { riskScore = 50; }
    }
    
    // 综合得分：经济水平(40%) + 薪资水平(30%) + 风险可控性(30%)
    const score = Math.round(ecoLevel * 4 + salaryCoef * 30 + riskScore * 0.3);
    
    return {
      name: name,
      tag: city['定位标签'] || '',
      salaryCoef: salaryCoef,
      ecoLevel: ecoLevel,
      riskLevel: riskLv,
      score: score,
    };
  }).sort((a, b) => b.score - a.score);
  
  let html = `<div class="page-head">
    <div>
      <div class="page-title">城市投资吸引力排名</div>
      <div class="page-sub">${cities.length}个城市综合吸引力排名 · 经济+薪资+风险三维度</div>
    </div>
  </div>`;
  
  // TOP3 展示
  html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px;">';
  const medals = [
    { icon: '🥇', color: '#f59e0b', bg: '#fffbeb' },
    { icon: '🥈', color: '#94a3b8', bg: '#f8fafc' },
    { icon: '🥉', color: '#ea580c', bg: '#fff7ed' },
  ];
  ranked.slice(0, 3).forEach((c, i) => {
    html += `<div style="background:${medals[i].bg};border-radius:12px;padding:20px;text-align:center;border:2px solid ${medals[i].color}22;">
      <div style="font-size:36px;">${medals[i].icon}</div>
      <div style="font-size:20px;font-weight:700;color:#0f172a;margin-top:4px;">${esc(c.name)}</div>
      <div style="font-size:28px;font-weight:800;color:${medals[i].color};margin-top:8px;">${c.score}</div>
      <div style="font-size:12px;color:#64748b;margin-top:4px;">综合得分</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:8px;">${esc(c.tag || '').substring(0, 20)}</div>
    </div>`;
  });
  html += '</div>';
  
  // 完整排名表
  html += '<div class="section-card"><div class="section-title">📊 完整排名</div>';
  html += '<div style="overflow-x:auto;"><table class="data-table rank-table">';
  html += '<thead><tr><th style="width:60px;">排名</th><th>城市</th><th style="width:120px;">定位标签</th><th style="width:90px;text-align:center;">经济水平</th><th style="width:90px;text-align:center;">薪资系数</th><th style="width:80px;text-align:center;">风险等级</th><th style="width:100px;text-align:center;">综合得分</th></tr></thead><tbody>';
  
  ranked.forEach((c, i) => {
    const rankBadge = i < 3 
      ? `<span class="rank-badge rank-${i+1}">${i+1}</span>` 
      : `<span class="rank-badge rank-normal">${i+1}</span>`;
    const riskLvColor = { 'A': '#10b981', 'B': '#3b82f6', 'C': '#f59e0b', 'D': '#f97316', 'E': '#ef4444' };
    const riskColor = riskLvColor[c.riskLevel] || '#6b7280';
    html += `<tr>
      <td style="text-align:center;">${rankBadge}</td>
      <td><b style="font-size:14px;">${esc(c.name)}</b></td>
      <td><span class="tag sm" style="background:#f1f5f9;color:#475569;">${esc(c.tag || '—')}</span></td>
      <td style="text-align:center;"><b>${c.ecoLevel}</b> <span style="font-size:11px;color:#94a3b8;">/ 10</span></td>
      <td style="text-align:center;"><b>${c.salaryCoef}</b></td>
      <td style="text-align:center;"><span class="lv-tag" style="background:${riskColor}15;color:${riskColor};">${c.riskLevel}级</span></td>
      <td style="text-align:center;"><b style="font-size:15px;color:var(--c-brand);">${c.score}</b></td>
    </tr>`;
  });
  html += '</tbody></table></div></div>';
  
  // 评分说明
  html += `<div class="section-card">
    <div class="section-title">📋 排名指标说明</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;">
      <div style="padding:12px;background:#f0fdf4;border-radius:8px;">
        <div style="font-weight:600;color:#059669;margin-bottom:4px;">经济水平 (40%)</div>
        <div style="font-size:12px;color:#065f46;">基于城市GDP、产业结构、发展阶段等综合评分（1-10分）</div>
      </div>
      <div style="padding:12px;background:#eff6ff;border-radius:8px;">
        <div style="font-weight:600;color:#2563eb;margin-bottom:4px;">薪资水平 (30%)</div>
        <div style="font-size:12px;color:#1e40af;">城市薪资系数，反映当地收入水平和购买力</div>
      </div>
      <div style="padding:12px;background:#fef3c7;border-radius:8px;">
        <div style="font-weight:600;color:#d97706;margin-bottom:4px;">风险可控性 (30%)</div>
        <div style="font-size:12px;color:#92400e;">基于城市风险评级，风险越低得分越高</div>
      </div>
    </div>
  </div>`;
  
  return html;
}


// ------------------------------------------------------------------ 岗位×行业×城市 交叉分析
function pageCrossAnalysis() {
  let html = `<div class="page-head">
    <div>
      <div class="page-title">岗位跨行业/城市对比</div>
      <div class="page-sub">同一岗位在不同行业、不同城市的薪资差异分析</div>
    </div>
  </div>`;
  
  html += `<div class="section-card">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div>
        <label style="font-size:13px;color:#475569;">搜索岗位</label>
        <div style="position:relative;">
          <input type="text" id="crossJobSearch" class="input" placeholder="输入岗位名称，如：Java开发工程师" oninput="crossJobSearch()" onfocus="crossJobSearch()" />
          <div id="crossJobDropdown" style="position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;max-height:240px;overflow-y:auto;z-index:100;display:none;box-shadow:0 4px 12px rgba(0,0,0,.1);"></div>
        </div>
      </div>
      <div>
        <label style="font-size:13px;color:#475569;">对比城市数</label>
        <select id="crossCityNum" class="input" onchange="renderCrossAnalysis()">
          <option value="5">TOP 5 城市</option>
          <option value="10">TOP 10 城市</option>
          <option value="all">全部城市</option>
        </select>
      </div>
    </div>
    <div id="crossSelectedJob" style="margin-top:12px;padding:8px 12px;background:#f0f9ff;border-radius:6px;font-size:13px;color:#0369a1;display:none;">
      当前分析岗位：<b id="crossJobName">—</b>
    </div>
  </div>`;
  
  html += '<div id="crossResult" class="section-card"><div style="color:#94a3b8;text-align:center;padding:40px;">👆 请在上方搜索框中输入岗位名称开始分析</div></div>';
  
  // 点击外部关闭下拉
  setTimeout(() => {
    document.addEventListener('click', (e) => {
      const dd = document.getElementById('crossJobDropdown');
      const input = document.getElementById('crossJobSearch');
      if (dd && input && !dd.contains(e.target) && e.target !== input) {
        dd.style.display = 'none';
      }
    });
  }, 100);
  
  return html;
}

function crossJobSearch() {
  const kw = document.getElementById('crossJobSearch').value.trim().toLowerCase();
  const dd = document.getElementById('crossJobDropdown');
  if (!kw || !dd) { dd.style.display = 'none'; return; }
  
  // 搜索匹配的岗位（去重）
  const seen = new Set();
  const matches = [];
  for (let i = 0; i < DB.jobs.length; i++) {
    const j = DB.jobs[i];
    const name = j['常见职位'] || '';
    if (seen.has(name)) continue;
    if (name.toLowerCase().includes(kw)) {
      seen.add(name);
      matches.push({ name: name, code: j['职位编号'], big: j['行业大类'] });
      if (matches.length >= 20) break;
    }
  }
  
  if (!matches.length) {
    dd.innerHTML = '<div style="padding:16px;text-align:center;color:#94a3b8;font-size:13px;">未找到匹配岗位</div>';
  } else {
    dd.innerHTML = matches.map(m => `
      <div class="cross-job-item" style="padding:8px 12px;cursor:pointer;transition:.15s;border-bottom:1px solid #f1f5f9;" 
           onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='#fff'"
           onclick="selectCrossJob('${esc(m.name)}','${esc(m.code)}')">
        <div style="font-size:13px;font-weight:500;color:#0f172a;">${esc(m.name)}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:2px;">${esc(m.big || '')}</div>
      </div>
    `).join('');
  }
  dd.style.display = 'block';
}

function selectCrossJob(name, code) {
  document.getElementById('crossJobSearch').value = name;
  document.getElementById('crossJobDropdown').style.display = 'none';
  document.getElementById('crossSelectedJob').style.display = 'block';
  document.getElementById('crossJobName').textContent = name;
  // 保存选中的岗位code供render使用
  window._crossJobCode = code;
  window._crossJobName = name;
  renderCrossAnalysis();
}

function renderCrossAnalysis() {
  const jobCode = window._crossJobCode;
  const cityNum = document.getElementById('crossCityNum').value;
  
  if (!jobCode) return;
  
  const job = DB.jobs.find(j => j['职位编号'] === jobCode);
  if (!job) {
    // 按名称找
    const jobName = window._crossJobName || '';
    const found = DB.jobs.find(j => j['常见职位'] === jobName);
    if (!found) return;
    window._crossJobCode = found['职位编号'];
  }
  
  const jobName = window._crossJobName || (job ? job['常见职位'] : '');
  const bigInd = job ? job['行业大类'] : '';
  
  // 在各行业中找同名岗位
  const sameNameJobs = DB.jobs.filter(j => j['常见职位'] === jobName);
  
  // 在各城市中找薪资
  const citySalary = [];
  for (const key in DB.salary) {
    const parts = key.split('|');
    if (parts.length >= 2 && parts[1] === jobName) {
      citySalary.push({ city: parts[0], salary: DB.salary[key] });
    }
  }
  
  // 按薪资中位数排序
  citySalary.sort((a, b) => (b.salary.monthly_median || 0) - (a.salary.monthly_median || 0));
  
  let showCount = cityNum === 'all' ? citySalary.length : parseInt(cityNum);
  const topCities = citySalary.slice(0, showCount);
  
  if (!topCities.length) {
    document.getElementById('crossResult').innerHTML = `
      <div style="color:#94a3b8;text-align:center;padding:40px;">暂无「${esc(jobName)}」的城市薪资数据</div>
    `;
    return;
  }
  
  // 生成柱状图
  const maxSal = topCities.length ? topCities[0].salary.monthly_median || 10000 : 10000;
  let chartHtml = '<div style="margin-top:16px;">';
  topCities.forEach((cs, i) => {
    const med = cs.salary.monthly_median || 0;
    const pct = (med / maxSal * 100).toFixed(1);
    const ppi = cs.salary.purchasing_power_index || 1;
    const realSal = Math.round(med * ppi);
    const rankBadge = i < 3 ? `<span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:50%;background:${i===0?'#f59e0b':i===1?'#94a3b8':'#ea580c'};color:#fff;font-weight:700;font-size:11px;margin-right:6px;">${i+1}</span>` : `<span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:50%;background:#e2e8f0;color:#64748b;font-weight:600;font-size:11px;margin-right:6px;">${i+1}</span>`;
    chartHtml += `<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
      <div style="width:90px;text-align:left;font-size:13px;color:#334155;flex-shrink:0;display:flex;align-items:center;">${rankBadge}${esc(cs.city)}</div>
      <div style="flex:1;position:relative;height:32px;background:#f1f5f9;border-radius:6px;overflow:hidden;">
        <div style="position:absolute;left:0;top:0;height:100%;width:${pct}%;background:linear-gradient(90deg,#3b82f6,#8b5cf6);"></div>
        <div style="position:absolute;left:12px;top:0;height:100%;line-height:32px;font-size:13px;color:#fff;font-weight:600;">${med.toLocaleString()} 元/月</div>
        <div style="position:absolute;right:12px;top:0;height:100%;line-height:32px;font-size:12px;color:#0f172a;background:#fef3c7;padding:0 10px;border-radius:4px;font-weight:500;">购买力等值 ${realSal.toLocaleString()}</div>
      </div>
    </div>`;
  });
  chartHtml += '</div>';
  
  // 跨行业对比
  let indHtml = '<div style="margin-top:24px;padding-top:20px;border-top:1px solid #e2e8f0;">';
  indHtml += '<div class="section-title">🔄 跨行业同名岗位对比</div>';
  if (sameNameJobs.length > 1) {
    indHtml += '<table class="data-table"><tr><th>行业大类</th><th>细分行业</th><th>审核要点</th></tr>';
    sameNameJobs.slice(0, 8).forEach(j => {
      indHtml += `<tr>
        <td>${esc(j['行业大类'])}</td>
        <td>${esc(j['细分行业'])}</td>
        <td style="font-size:12px;color:#64748b;">${esc((j['审批要点']||'').substring(0, 80))}${j['审批要点'] && j['审批要点'].length > 80 ? '...' : ''}</td>
      </tr>`;
    });
    indHtml += '</table>';
    indHtml += `<p style="font-size:12px;color:#94a3b8;margin-top:8px;">共找到 ${sameNameJobs.length} 个行业的同名岗位，以上展示前8个</p>`;
  } else {
    indHtml += '<p style="color:#94a3b8;text-align:center;padding:20px;">暂无跨行业同名岗位数据</p>';
  }
  indHtml += '</div>';
  
  document.getElementById('crossResult').innerHTML = `
    <div class="section-title" style="margin-top:0;">💰 ${esc(jobName)} · 城市薪资排名 (${topCities.length}个城市)</div>
    ${chartHtml}
    ${indHtml}
  `;
}


// ------------------------------------------------------------------ 薪资增长趋势折线图
function renderSalaryTrend(jobName, salaryData) {
  if (!salaryData || !salaryData.trend) return '';
  
  const trend = salaryData.trend;
  const years = Object.keys(trend).sort();
  if (years.length < 2) return '';
  
  const w = 500, h = 200;
  const pad = { l: 50, r: 20, t: 20, b: 30 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  
  // 找最大值
  let maxVal = 0;
  years.forEach(y => { maxVal = Math.max(maxVal, trend[y].max || 0); });
  maxVal = Math.ceil(maxVal / 1000) * 1000;
  
  // 中位数折线
  let medianPts = [];
  let minPts = [];
  let maxPts = [];
  years.forEach((y, i) => {
    const x = pad.l + (cw / (years.length - 1)) * i;
    const med = trend[y].median || 0;
    const mn = trend[y].min || 0;
    const mx = trend[y].max || 0;
    medianPts.push(x + ',' + (pad.t + ch * (1 - med / maxVal)));
    minPts.push(x + ',' + (pad.t + ch * (1 - mn / maxVal)));
    maxPts.push(x + ',' + (pad.t + ch * (1 - mx / maxVal)));
  });
  
  // Y轴刻度
  let yTicks = '';
  for (let i = 0; i <= 4; i++) {
    const v = maxVal * i / 4;
    const y = pad.t + ch * (1 - i / 4);
    yTicks += `<line x1="${pad.l}" y1="${y}" x2="${pad.l + cw}" y2="${y}" stroke="#f1f5f9" stroke-width="1"/>`;
    yTicks += `<text x="${pad.l - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#94a3b8">${Math.round(v/1000)}k</text>`;
  }
  
  // X轴标签
  let xLabels = '';
  years.forEach((y, i) => {
    const x = pad.l + (cw / (years.length - 1)) * i;
    xLabels += `<text x="${x}" y="${h - 10}" text-anchor="middle" font-size="11" fill="#64748b">${y}</text>`;
  });
  
  const minArea = minPts.map((p, i) => {
    const [x, y] = p.split(',');
    const [mx, my] = maxPts[i].split(',');
    return '';
  }).join('');
  
  const maxPath = maxPts.join(' ');
  const minPath = minPts.join(' ');
  const medianPath = medianPts.join(' ');
  
  // 填充区间
  let areaPath = 'M' + minPts[0];
  for (let i = 1; i < minPts.length; i++) areaPath += ' L' + minPts[i];
  for (let i = maxPts.length - 1; i >= 0; i--) areaPath += ' L' + maxPts[i];
  areaPath += ' Z';
  
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:600px;">
    ${yTicks}
    <polygon points="${areaPath}" fill="#dbeafe" opacity="0.5"/>
    <polyline points="${maxPath}" fill="none" stroke="#93c5fd" stroke-width="1" stroke-dasharray="3,3"/>
    <polyline points="${minPath}" fill="none" stroke="#93c5fd" stroke-width="1" stroke-dasharray="3,3"/>
    <polyline points="${medianPath}" fill="none" stroke="#2563eb" stroke-width="2"/>
    ${medianPts.map(p => {
      const [x, y] = p.split(',');
      return `<circle cx="${x}" cy="${y}" r="3" fill="#2563eb"/>`;
    }).join('')}
    ${xLabels}
  </svg>
  <div style="display:flex;gap:16px;justify-content:center;font-size:12px;color:#64748b;margin-top:8px;">
    <span><span style="display:inline-block;width:12px;height:2px;background:#2563eb;vertical-align:middle;margin-right:4px;"></span>中位数</span>
    <span><span style="display:inline-block;width:12px;height:2px;background:#93c5fd;border-top:1px dashed #93c5fd;vertical-align:middle;margin-right:4px;"></span>最高/最低</span>
  </div>`;
}


// ------------------------------------------------------------------ 版本更新日志
const VERSION_LOG = [
  {
    version: 'V9.1',
    date: '2026-10-08',
    features: [
      { type: 'fix', text: '授信评分卡算法重构 - 5维度评分+门控惩罚+百分位等级分配，解决A级0%/C级72.9%极端分布' },
      { type: 'fix', text: '风险分析TOP20城市筛选 - 修复下拉框显示[object Object]+切换城市后行业无变化' },
      { type: 'fix', text: '数据看板行业饼图 - 改为环形图布局，修复UI异常' },
      { type: 'opt', text: '数据说明全面更新 - 字段数/数据来源/评分维度描述与实际数据对齐' },
      { type: 'opt', text: '版本号动态化 - 左下角版本号从meta读取，不再硬编码' },
      { type: 'opt', text: '移除看板风险等级分布模块（无区分度）' },
    ]
  },
  {
    version: 'V9.0',
    date: '2026-10-08',
    features: [
      { type: 'new', text: '授信评分卡百分位等级分配机制' },
      { type: 'new', text: '评分修正：门控惩罚+一致性奖励+方差惩罚' },
      { type: 'fix', text: '城市筛选TOP20行业动态更新' },
      { type: 'fix', text: '饼图环形布局优化' },
    ]
  },
  {
    version: 'V8.0',
    date: '2026-10-07',
    features: [
      { type: 'new', text: '行业对比矩阵 - 2-4个行业全方位对比（13维度）' },
      { type: 'new', text: '反欺诈识别要点 - 8类岗位专项造假识别技巧' },
      { type: 'new', text: '最近浏览记录 - 快速回访（最多20条）' },
      { type: 'new', text: '热力图排序 - 风险从高到低/从低到高' },
      { type: 'new', text: '象限图增强 - 四象限统计+点击跳转看板' },
      { type: 'new', text: '城市风控筛选 - 按城市切换+风险层级统计' },
      { type: 'opt', text: 'sha256JS算法修复 - 支持中文密码+初始值污染修复' },
      { type: 'opt', text: '数据合并去重 - city_risks/salary自动去重' },
      { type: 'opt', text: 'UI风格统一 - 新增功能全部使用规范CSS类' },
      { type: 'fix', text: '修复meta统计数据下划线命名字段失真' },
      { type: 'fix', text: '修复新增页面面包屑标题缺失' },
    ]
  },
  {
    version: 'V7.5',
    date: '2026-10-07',
    features: [
      { type: 'new', text: '综合授信评分卡 - 5维度加权评分' },
      { type: 'new', text: '城市投资吸引力排名' },
      { type: 'new', text: '岗位跨行业跨城市交叉分析' },
      { type: 'new', text: '行业差异化授信标准' },
      { type: 'new', text: '风险评分模型透明化' },
      { type: 'new', text: '电核访谈助手' },
      { type: 'new', text: '额度计算器' },
      { type: 'opt', text: '搜索倒排索引加速' },
      { type: 'opt', text: '仪表盘新增饼图+风险分布图' },
      { type: 'opt', text: '暗色主题支持' },
      { type: 'fix', text: '修复薪资趋势数据缺失问题' },
    ]
  },
];

function showVersionLog() {
  const typeMap = { new: { icon: '✨', label: '新增', color: '#10b981' }, opt: { icon: '⚡', label: '优化', color: '#3b82f6' }, fix: { icon: '🐛', label: '修复', color: '#f59e0b' } };
  
  let html = '';
  VERSION_LOG.forEach(v => {
    html += `<div style="margin-bottom:20px;">
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px;">
        <span style="font-size:18px;font-weight:700;color:#0f172a;">${v.version}</span>
        <span style="font-size:12px;color:#94a3b8;">${v.date}</span>
      </div>
      <div style="padding-left:12px;border-left:2px solid #e2e8f0;">`;
    v.features.forEach(f => {
      const t = typeMap[f.type] || typeMap.opt;
      html += `<div style="display:flex;gap:8px;margin-bottom:6px;font-size:13px;">
        <span style="color:${t.color};flex-shrink:0;">${t.icon}</span>
        <span style="color:#334155;">${f.text}</span>
      </div>`;
    });
    html += '</div></div>';
  });
  
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;';
  modal.innerHTML = `<div style="background:#fff;border-radius:12px;padding:24px;width:500px;max-width:90vw;max-height:80vh;overflow-y:auto;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 style="margin:0;">📋 版本更新日志</h3>
      <button class="btn" onclick="this.closest('[style*=fixed]').style.display=\'none\';this.closest('[style*=fixed]').remove();">关闭</button>
    </div>
    ${html}
  </div>`;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) { modal.remove(); } };
}


const PAGES = {

  dashboard: pageDashboard,

  'ana-industry': pageAnaIndustry,

  'ana-job': pageAnaJob,

  'ana-city': pageAnaCity,

  'ana-salary': pageAnaSalary,

  'ana-risk': pageAnaRisk,

  'ana-finance': pageAnaFinance,

  'ind-overview': pageIndOverview,

  'risk-quick': pageRiskQuick,

  'city-overview': pageCityOverview,

  industries: pageIndustries,

  jobs: pageJobs,

  cityrisks: pageCityRisks,

  modes: pageModes,

  search: pageSearch,

  compare: pageCompare,

  'ind-compare': pageIndCompare,

  dataupdate: pageDataUpdate,

  interview: pageInterview,

  calculator: pageCalculator,

  'score-card': pageScoreCard,

  'city-rank': pageCityRank,

  'cross-analysis': pageCrossAnalysis,

};



function debounce(fn, ms) {

  let t; return function () { clearTimeout(t); const a = arguments; t = setTimeout(() => fn.apply(this, a), ms); };

}


// ---- 返回顶部按钮
(function initBackToTop() {
  const btn = document.createElement('button');
  btn.id = 'backToTop';
  btn.innerHTML = '↑';
  btn.title = '返回顶部';
  btn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  document.body.appendChild(btn);
  
  window.addEventListener('scroll', () => {
    btn.style.display = window.scrollY > 300 ? 'block' : 'none';
  });
})();


// ---- 仪表盘饼图
function renderDashPie(industries, title) {
  const countMap = {};
  industries.forEach(ind => {
    const big = ind['行业大类'] || '其他';
    countMap[big] = (countMap[big] || 0) + 1;
  });
  
  const sorted = Object.entries(countMap).sort((a, b) => b[1] - a[1]);
  const topN = sorted.slice(0, 8);
  const otherCount = sorted.slice(8).reduce((s, [, c]) => s + c, 0);
  if (otherCount > 0) topN.push(['其他', otherCount]);
  
  const total = industries.length;
  const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#64748b'];
  
  let cumulative = 0;
  const cx = 80, cy = 80, rOuter = 65, rInner = 38;
  let paths = '';
  
  topN.forEach(([name, count], i) => {
    const angle = (count / total) * 2 * Math.PI;
    const startAngle = cumulative - Math.PI / 2;
    const endAngle = cumulative + angle - Math.PI / 2;
    cumulative += angle;
    
    const x1o = cx + rOuter * Math.cos(startAngle);
    const y1o = cy + rOuter * Math.sin(startAngle);
    const x2o = cx + rOuter * Math.cos(endAngle);
    const y2o = cy + rOuter * Math.sin(endAngle);
    const x1i = cx + rInner * Math.cos(endAngle);
    const y1i = cy + rInner * Math.sin(endAngle);
    const x2i = cx + rInner * Math.cos(startAngle);
    const y2i = cy + rInner * Math.sin(startAngle);
    const largeArc = angle > Math.PI ? 1 : 0;
    
    if (topN.length === 1) {
      paths += `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="${colors[i % colors.length]}"/>`;
      paths += `<circle cx="${cx}" cy="${cy}" r="${rInner}" fill="#fff"/>`;
    } else {
      paths += `<path d="M ${x1o} ${y1o} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2o} ${y2o} L ${x1i} ${y1i} A ${rInner} ${rInner} 0 ${largeArc} 0 ${x2i} ${y2i} Z" fill="${colors[i % colors.length]}" stroke="#fff" stroke-width="1.5"/>`;
    }
  });
  
  let legend = '';
  topN.forEach(([name, count], i) => {
    const pct = (count / total * 100).toFixed(1);
    legend += `<div class="lg-item"><span class="lg-dot" style="background:${colors[i % colors.length]}"></span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(name)}</span><span style="color:#64748b;flex-shrink:0;margin-left:8px;">${count} (${pct}%)</span></div>`;
  });
  
  return `<div class="dash-pie-wrap">
    <div class="dash-pie"><svg viewBox="0 0 160 160" style="max-width:160px;max-height:160px;">${paths}<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="10" fill="#94a3b8">${esc(title || '行业分布')}</text><text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="18" font-weight="700" fill="#0f172a">${total}</text></svg></div>
    <div class="dash-pie-legend">${legend}</div>
  </div>`;
}


// ---- 城市概览雷达图
function renderRadarChart(labels, dataList) {
  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const r = 110;
  const n = labels.length;
  
  // 网格
  let grid = '';
  for (let level = 1; level <= 4; level++) {
    const lr = r * level / 4;
    let points = [];
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
      const x = cx + lr * Math.cos(angle);
      const y = cy + lr * Math.sin(angle);
      points.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    grid += `<polygon points="${points.join(' ')}" fill="none" stroke="#e2e8f0" stroke-width="1"/>`;
  }
  
  // 轴线
  let axes = '';
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    axes += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`;
  }
  
  // 标签
  let labelHtml = '';
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const lr = r + 18;
    const x = cx + lr * Math.cos(angle);
    const y = cy + lr * Math.sin(angle);
    labelHtml += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="#475569">${esc(labels[i])}</text>`;
  }
  
  // 数据区域
  const colors = ['#3b82f6', '#10b981', '#f59e0b'];
  let dataHtml = '';
  dataList.forEach((data, di) => {
    let points = [];
    for (let i = 0; i < n; i++) {
      const v = Math.min(100, Math.max(0, data.values[i] || 0));
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
      const vr = r * v / 100;
      const x = cx + vr * Math.cos(angle);
      const y = cy + vr * Math.sin(angle);
      points.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    const color = colors[di % colors.length];
    dataHtml += `<polygon points="${points.join(' ')}" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="2"/>`;
    points.forEach(p => {
      const [x, y] = p.split(',');
      dataHtml += `<circle cx="${x}" cy="${y}" r="3" fill="${color}"/>`;
    });
  });
  
  return `<div class="radar-chart"><svg viewBox="0 0 ${size} ${size}">${grid}${axes}${dataHtml}${labelHtml}</svg></div>`;
}


// ---- 笔记功能
function showNoteEditor(targetType, targetId, targetName) {
  const key = targetType + '_' + targetId;
  const existing = Storage.get('notes_' + key, '');
  
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;';
  modal.innerHTML = `<div style="background:#fff;border-radius:12px;padding:20px;width:500px;max-width:90vw;">
    <h3 style="margin:0 0 12px;">📝 笔记 - ${esc(targetName)}</h3>
    <textarea id="noteTextarea" class="input" style="min-height:200px;font-family:inherit;resize:vertical;">${esc(existing)}</textarea>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button class="btn" onclick="this.closest('.modal-mask').remove()">取消</button>
      <button class="btn btn-primary" id="noteSaveBtn">保存</button>
    </div>
  </div>`;
  
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.getElementById('noteSaveBtn').onclick = () => {
    const text = document.getElementById('noteTextarea').value;
    Storage.set('notes_' + key, text);
    modal.remove();
    toast('笔记已保存');
  };
}


// ---- P1 数据修复：薪资补全、城市统一、趋势修复、元数据更新
(function fixData() {
  // 1. 趋势数据修复：从 annual 生成缺失的 trend
  for (const key in DB.salary) {
    const s = DB.salary[key];
    if (!s) continue;
    if (!s.trend && s.annual) {
      s.trend = { '2024': { min: Math.round(s.monthly_min * 0.9), max: Math.round(s.monthly_max * 0.9), median: Math.round(s.monthly_median * 0.9) } };
    }
    // 确保有 annual_median
    if (s.annual && !s.annual_median) s.annual_median = s.annual;
  }
  
  // 2. 元数据更新（同时修正驼峰和下划线两套命名，确保所有页面显示正确）
  if (DB.meta) {
    DB.meta.version = DB.meta.version || 'V8.0';
    DB.meta.updateDate = DB.meta.updateDate || new Date().toISOString().split('T')[0];
    // 驼峰命名
    DB.meta.industryCount = DB.industries.length;
    DB.meta.jobCount = DB.jobs.length;
    DB.meta.cityCount = DB.cities.length;
    DB.meta.cityRiskCount = DB.city_risks.length;
    DB.meta.modeCount = DB.modes.length;
    DB.meta.salaryCount = Object.keys(DB.salary).length;
    // 下划线命名（代码中大量使用，必须同步更新）
    DB.meta.industry_count = DB.industries.length;
    DB.meta.job_count = DB.jobs.length;
    DB.meta.city_count = DB.cities.length;
    DB.meta.city_risk_count = DB.city_risks.length;
    DB.meta.mode_count = DB.modes.length;
    DB.meta.salary_count = Object.keys(DB.salary).length;
  }
  
  // 3. 职位编码去重（按职位编号）
  const seenCodes = new Set();
  DB.jobs = DB.jobs.filter(job => {
    const code = job['职位编号'] || job['职位代码'];
    if (!code) return true;
    if (seenCodes.has(code)) return false;
    seenCodes.add(code);
    return true;
  });
})();


// ---- 主题按钮 & 初始化
(function initThemeAndHeader() {
  // 在 header 加主题切换按钮
  const header = document.querySelector('.header-right') || document.querySelector('.top-right');
  if (header) {
    const btn = document.createElement('button');
    btn.id = 'themeBtn';
    btn.className = 'btn';
    btn.style.cssText = 'padding:6px 12px;font-size:13px;';
    btn.onclick = toggleTheme;
    btn.textContent = S.theme === 'dark' ? '☀️ 亮色' : '🌙 暗色';
    header.appendChild(btn);
  }
  
  // 应用主题
  applyTheme();
})();


// 自动恢复登录（已移除：每次访问需重新登录）


// 账号密码需用户自行输入

