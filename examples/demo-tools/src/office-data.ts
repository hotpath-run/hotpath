// Shape of fixtures/<set>/office.json. Fields are optional-ish in the drift
// set, where one field of each first tool is renamed on purpose.
export interface Office {
  date: string;
  tickets: { pages: Array<Array<Record<string, string>>> };
  order: Record<string, unknown>;
  customers: Record<string, Record<string, unknown>>;
  shipping: Record<string, Record<string, unknown>>;
  projects: Array<Record<string, string>>;
  project_details: Record<string, Record<string, unknown>>;
  sales: Array<Record<string, unknown>>;
  incident: Record<string, unknown>;
  invoices: Array<Record<string, unknown>>;
  meetings: {
    timezone: string;
    utc_offset: string;
    meetings: Array<Record<string, string>>;
  };
}
