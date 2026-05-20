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
    if (row.some(c => normalize(c) === 'company')) return i;
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
 * Parse a workbook buffer or path, return account rows ready for upsert.
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

module.exports = { parseAccountTracker };
