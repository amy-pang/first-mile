# Cambridge Broadway bicycle counter

Saved 2026-10-18 for Hackachusetts.

Automated bicycle counts from the Broadway Eco-Totem in Cambridge, from 1 Jan 2024 onward. One counter is not a citywide total. The live call returns the 100 latest rows of that window. data.csv is the saved window.

Rows in data.csv: 17123

Columns: when, day, total, entries, exits

How to use it

- Spreadsheets: open data.csv in Excel or Google Sheets.
- Fresh copy: run `python fetch.py` or `node fetch.js`. Both call the URL below and save the response.
- The preview on the Hackachusetts site is a few rows of this same table.

Direct request

https://data.cambridgema.gov/resource/q8v9-mcfg.json?$select=datetime,day,total,entries,exits&$where=datetime%20%3E=%20%272024-01-01T00:00:00%27&$order=datetime%20DESC&$limit=100

Check the source license before publishing a project.
