const XLSX = require('xlsx');

const HEADER_MAP = {
  'company':                  'name',
  'revenue':                  'revenue',
  'category':                 'subIndustry',
  'vertical':                 'industry',
  'location':                 '__location',
  'priority tier':            'priorityTier',
  'deal motion':              'dealMotion',
  'target close':             '__targetClose',
  'close quarter':            'closeQuarter',
  'top c3 ai use cases':      'useCases',
  'primary stakeholder':      'primaryStakeholder',
  'backup stakeholders':      'backupStakeholders',
  'warm intro paths':         'warmIntroPaths',
  'q1 weekly focus':          'weeklyFocus',
  'q1 weekly focus (key gates)': 'weeklyFocus',
  'outreach status':          'outreachStatus',
  'last contact date':        '__lastContactedAt',
  'my notes':                 'myNotes',
  'rep':                      'rep',
};

// Fields that need date parsing during apply
const DATE_FIELDS = new Set(['targetCloseDate', 'lastContactedAt']);

function normalize(s) {
  return (s == null ? '' : String(s)).trim().toLowerCase();
}

function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    // Excel serial date
    const ms = (value - 25569) * 86400 * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function parseLocation(loc) {
  if (!loc) return { city: null, region: null, country: null };
  const parts = String(loc).split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 1) return { city: parts[0], region: null, country: null };
  if (parts.length === 2) return { city: parts[0], region: parts[1], country: null };
  return { city: parts[0], region: parts[1], country: parts.slice(2).join(', ') };
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    if (row.some(c => {
      const n = normalize(c);
      return n === 'company' || n === 'company name' || n === 'account' || n === 'account name';
    })) return i;
  }
  return -1;
}

function buildColumnIndex(headerRow) {
  const idx = {};
  headerRow.forEach((cell, i) => {
    const key = normalize(cell);
    if (HEADER_MAP[key]) idx[HEADER_MAP[key]] = i;
  });
  return idx;
}

function parseSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const headerIdx = findHeaderRow(rows);
  if (headerIdx < 0) {
    return { accounts: [], warnings: ["Could not find header row containing 'Company'"] };
  }
  const colIndex = buildColumnIndex(rows[headerIdx]);
  if (colIndex.name == null) {
    return { accounts: [], warnings: ["No 'Company' column found"] };
  }

  const warnings = [];
  const accounts = [];

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const name = row[colIndex.name];
    if (!name || typeof name !== 'string' || !name.trim()) continue;

    const acct = { name: name.trim() };
    for (const [field, ci] of Object.entries(colIndex)) {
      if (ci == null) continue;
      const value = row[ci];
      if (value == null || value === '') continue;
      if (field === '__location') {
        const { city, region, country } = parseLocation(value);
        if (city) acct.city = city;
        if (region) acct.region = region;
        if (country) acct.country = country;
      } else if (field === '__targetClose') {
        const d = parseDate(value);
        if (d) acct.targetCloseDate = d;
      } else if (field === '__lastContactedAt') {
        const d = parseDate(value);
        if (d) acct.lastContactedAt = d;
      } else {
        acct[field] = typeof value === 'string' ? value.trim() : value;
      }
    }
    accounts.push(acct);
  }

  return { accounts, warnings };
}

/**
 * Parse a workbook buffer or path, return account rows ready for upsert
 * using the legacy hardcoded HEADER_MAP.
 *
 * Looks for the first sheet whose name contains "account tracker" (case-insensitive),
 * falls back to the first sheet.
 */
function parseAccountTracker(input) {
  const wb = Buffer.isBuffer(input)
    ? XLSX.read(input, { type: 'buffer', cellDates: true })
    : XLSX.readFile(input, { cellDates: true });

  const sheetName = wb.SheetNames.find(s => /account tracker/i.test(s)) || wb.SheetNames[0];
  if (!sheetName) return { accounts: [], warnings: ['Workbook has no sheets'], sheetName: null };

  const result = parseSheet(wb.Sheets[sheetName]);
  return { ...result, sheetName };
}

/**
 * Parse the raw workbook into { headers, rows, sampleRows, sheetName } without
 * applying any field mapping. Used by the preview endpoint so the AI mapper can
 * see the headers + sample data, and the user can confirm the mapping.
 */
function parseRaw(input) {
  const wb = Buffer.isBuffer(input)
    ? XLSX.read(input, { type: 'buffer', cellDates: true })
    : XLSX.readFile(input, { cellDates: true });
  const sheetName = wb.SheetNames.find(s => /account tracker/i.test(s)) || wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [], sampleRows: [], sheetName: null, warnings: ['Workbook has no sheets'] };

  const ws = wb.Sheets[sheetName];
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const headerIdx = findHeaderRow(allRows);
  if (headerIdx < 0) return { headers: [], rows: [], sampleRows: [], sheetName, warnings: ["Could not find header row containing 'Company' or 'Account Name'"] };

  const headers = (allRows[headerIdx] || []).map(h => (h == null ? '' : String(h).trim()));
  const dataRows = allRows.slice(headerIdx + 1).filter(r => Array.isArray(r) && r.some(c => c != null && c !== ''));
  const sampleRows = dataRows.slice(0, 3);

  return { headers, rows: dataRows, sampleRows, sheetName, warnings: [] };
}

/**
 * Apply a user-provided mapping to raw rows to produce account objects.
 *
 * @param {string[]}   headers   - Column headers in order.
 * @param {Array[]}    rows      - 2-D array of raw cell values.
 * @param {Object}     mapping   - { <header>: <field name | "_skip" | "notes"> }
 *                                 Special values: "_skip" drops the column,
 *                                 "notes" appends "<header>: <value>" to Account.notes.
 * @returns {{accounts: Object[], warnings: string[]}}
 */
function applyMapping(headers, rows, mapping) {
  const warnings = [];
  const accounts = [];
  const nameCol = headers.findIndex(h => mapping[h] === 'name');
  if (nameCol < 0) {
    return { accounts: [], warnings: ['No column was mapped to "name" — at least one column must be the company name.'] };
  }

  // Resolve special columns by index for speed
  const locationIdx = headers.findIndex(h => mapping[h] === '__location' || mapping[h] === 'location_split');

  for (const row of rows) {
    const name = row[nameCol];
    if (!name || (typeof name === 'string' && !name.trim())) continue;
    const acct = { name: typeof name === 'string' ? name.trim() : String(name) };
    const notesParts = [];

    headers.forEach((h, i) => {
      if (i === nameCol) return;
      const field = mapping[h];
      if (!field || field === '_skip') return;
      const value = row[i];
      if (value == null || value === '') return;

      if (field === 'notes') {
        notesParts.push(`${h}: ${typeof value === 'string' ? value.trim() : value}`);
        return;
      }
      if (field === '__location' || field === 'location_split') {
        const loc = parseLocation(value);
        if (loc.city)    acct.city = acct.city || loc.city;
        if (loc.region)  acct.region = acct.region || loc.region;
        if (loc.country) acct.country = acct.country || loc.country;
        return;
      }
      if (DATE_FIELDS.has(field)) {
        const d = parseDate(value);
        if (d) acct[field] = d;
        return;
      }
      if (field === 'foundedYear') {
        const n = parseInt(value);
        if (!isNaN(n)) acct.foundedYear = n;
        return;
      }
      acct[field] = typeof value === 'string' ? value.trim() : value;
    });

    if (notesParts.length) {
      acct.notes = (acct.notes ? acct.notes + '\n' : '') + notesParts.join('\n');
    }
    accounts.push(acct);
  }

  return { accounts, warnings };
}

module.exports = { parseAccountTracker, parseRaw, applyMapping };
