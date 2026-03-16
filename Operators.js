const operators = {
  $eq: (a, b) => a === b,
  $ne: (a, b) => a !== b,
  $gt: (a, b) => a > b,
  $gte: (a, b) => a >= b,
  $lt: (a, b) => a < b,
  $lte: (a, b) => a <= b,
  $in: (a, b) => Array.isArray(b) && (Array.isArray(a) ? a.some(v => b.includes(v)) : b.includes(a)),
  $between: (a, [min, max]) => a >= min && a <= max,
  $exists: (val, shouldExist) => shouldExist ? val !== undefined : val === undefined,

  $startsWith: (a, b) => typeof a === 'string' && a.startsWith(b),
  $endsWith: (a, b) => typeof a === 'string' && a.endsWith(b),
  $contains: (a, b) => typeof a === 'string' && a.includes(b), // a.k.a. substring search

  $text: {
    global: (nodeValue, search) => {
      const normalize = str => String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\w\s]/g, '');
      const searchNorm = normalize(search);
      return Object.values(nodeValue).some(v => typeof v === 'object' ? this.fieldSearch(v, searchNorm) : normalize(v).includes(searchNorm));
    },
    field: (fieldValue, search) => {
      const normalize = str => String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\w\s]/g, '');
      const searchNorm = normalize(search);
      return Array.isArray(fieldValue) ? fieldValue.some(v => normalize(v).includes(searchNorm)) : normalize(fieldValue).includes(searchNorm);
    }
  },
  $like: (nodeValue, pattern) => typeof nodeValue === 'string' && typeof pattern === 'string' && new RegExp(`^${pattern.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i').test(nodeValue),
  $regex: (nodeValue, query) => typeof nodeValue === 'string' && new RegExp(query.$regex || query, 'i').test(nodeValue),
  $and: (node, conditions, ctx) => conditions.every(cond => ctx.createFilter(cond, ctx.allNodes)(node)),
  $or: (node, conditions, ctx) => conditions.some(cond => ctx.createFilter(cond, ctx.allNodes)(node)),
  $not: (node, condition, ctx) => !ctx.createFilter(condition, ctx.allNodes)(node),
  $edge: (startNode, filterQuery, ctx) => {
    if (!startNode.edges?.length || typeof filterQuery !== 'object' || filterQuery === null) return false;
    const filter = ctx.createFilter(filterQuery, ctx.allNodes);
    const queue = [...startNode.edges], visited = new Set(queue).add(startNode.id), found = [];
    while (queue.length) {
      const id = queue.shift(), node = ctx.allNodes[id];
      if (!node) continue;
      if (filter(node)) found.push(node);
      node.edges?.forEach(e => !visited.has(e) && visited.add(e) && queue.push(e));
    }
    if (found.length) startNode._edgeResult = found;
    return found.length > 0;
  }
};

export const getNestedValue = (obj, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' && k in o) ? o[k] : undefined, obj);

export const createFilter = (query, allNodes) => {
  if (Object.keys(query).length === 0) return () => true;
  return node => Object.entries(query).every(([key, cond]) => {
    if (key.startsWith('$')) return operators[key](node, cond, { createFilter, allNodes });
    let val = getNestedValue(node.value, key);
    if (val === undefined) {
      val = getNestedValue(node, key); // Búsqueda en la raíz como fallback
    }
    if (typeof cond !== 'object' || cond === null) return operators.$eq(val, cond);
    return Object.entries(cond).every(([op, v]) => {
      if (op === '$text') return operators.$text.field(val, v);
      if (op === '$between' && v.every(d => d instanceof Date)) return operators.$between(new Date(val), v);
      return (operators[op]?.(val, v, { createFilter, allNodes }) ?? false);
    });
  });
};

export const processNodes = (nodes, options) => {
  const { $edge: edgeQ, ...baseQ } = options.query || {};
  const filter = createFilter(baseQ, nodes);
  const startNodes = Object.values(nodes).filter(filter);

  const results = edgeQ ? (() => {
    const edgeFilter = createFilter({ $edge: edgeQ }, nodes);
    startNodes.forEach(n => edgeFilter(n));
    const map = new Map();
    startNodes.forEach(n => {
      if (n._edgeResult) {
        n._edgeResult.forEach(r => map.set(r.id, r));
        delete n._edgeResult;
      }
    });
    return Array.from(map.values());
  })() : startNodes;

  let res = [...results];


  if (options.field) {
    const dir = options.order === 'asc' ? 1 : -1;
    res.sort((a, b) => {
      const aV = getNestedValue(a.value, options.field);
      const bV = getNestedValue(b.value, options.field);
      if (typeof aV === 'string' && typeof bV === 'string') return aV.localeCompare(bV) * dir;
      return ((aV ?? 0) - (bV ?? 0)) * dir;
    });
  }
  if (options.$after) {
    const i = res.findIndex(n => n.id === options.$after);
    res = i >= 0 ? res.slice(i + 1) : [];
  }
  if (options.$before) {
    const i = res.findIndex(n => n.id === options.$before);
    res = i >= 0 ? res.slice(0, i) : [];
  }
  if (options.$limit) res = res.slice(0, options.$limit);

  return res;
};