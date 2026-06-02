import Papa from 'papaparse';

/**
 * Parse a ZoomInfo (or similar B2B export) CSV file into a normalised list
 * of prospect objects. Returns rows that have an email; everything else
 * is dropped.
 *
 * Each returned prospect includes a top-level `linkedIn` field (when the
 * source had one) so downstream callers — like the Research engine — can
 * pass it to a LinkedIn scraper. The existing /prospects/bulk endpoint
 * ignores fields outside its allowlist, so this is a no-op for existing
 * imports.
 */
export function parseZoomInfoCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      complete: (results) => {
        try {
          const mapped = results.data.map(mapRow).filter((p) => p.email);
          resolve(mapped);
        } catch (err) {
          reject(err);
        }
      },
      error: (err) => reject(err),
    });
  });
}

function mapRow(row) {
  const firstName = row['First Name'] || row['firstName'] || row['First'] || '';
  const lastName  = row['Last Name']  || row['lastName']  || row['Last']  || '';
  const email     = row['Email Address'] || row['Work Email'] || row['Email'] || row['email'] || '';
  const title     = row['Job Title'] || row['Title'] || row['jobTitle'] || row['Person Title'] || '';
  const phone     = row['Direct Phone Number'] || row['Phone Number (Direct)'] || row['Direct Phone']
                  || row['Mobile phone'] || row['Mobile Phone'] || row['Phone'] || row['phone'] || '';
  const companyName = row['Company Name'] || row['Company'] || row['companyName'] || row['Account Name'] || '';
  const country   = row['Country'] || row['Company Country'] || '';
  const region    = row['Person State'] || row['State'] || row['Person City'] || row['Region'] || '';
  const linkedIn  = row['LinkedIn Contact Profile URL'] || row['LinkedIn URL']
                  || row['LinkedIn Profile URL'] || row['Person LinkedIn URL'] || '';
  const industry  = row['Primary Industry'] || row['Primary Sub-Industry'] || '';
  const department = row['Department'] || '';

  // Store rich account context as JSON so it's available for enrichment / display
  const extra = {};
  if (linkedIn)                                          extra.linkedIn = linkedIn;
  if (row['Website'])                                    extra.website = row['Website'];
  if (industry)                                          extra.industry = industry;
  if (row['Revenue Range (in USD)'])                     extra.revenue = row['Revenue Range (in USD)'];
  if (row['Employee Range'])                             extra.employees = row['Employee Range'];
  if (row['Management Level'])                           extra.managementLevel = row['Management Level'];
  const companyLoc = [row['Company City'], row['Company State'], row['Company Country']]
    .filter(Boolean).join(', ');
  if (companyLoc)                                        extra.companyLocation = companyLoc;
  if (row['ZoomInfo Company Profile URL'])               extra.zoomInfoCompanyUrl = row['ZoomInfo Company Profile URL'];

  return {
    firstName,
    lastName,
    email,
    companyName,
    title,
    phone,
    country,
    region,
    techStack: industry || department,
    linkedIn, // top-level — consumed by research, ignored by /prospects/bulk allowlist
    notes: linkedIn ? `LinkedIn: ${linkedIn}` : '',
    trackingPixelData: Object.keys(extra).length ? JSON.stringify(extra) : undefined,
    enrichmentStatus: 'pending',
    status: 'Uncontacted',
    // Keep original row for round-tripping into the enriched CSV export
    _original: row,
  };
}
