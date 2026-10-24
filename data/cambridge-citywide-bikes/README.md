# Cambridge citywide bicycle counts

Saved 2026-10-18 for Hackachusetts.

Cambridge bicycle counts at named locations with a count year of 2018 or later. Earlier years remain on the city feed. The live call returns 100 rows of the same filter. data.csv is the saved slice.

Rows in data.csv: 92268

Columns: location, year, date, period, street, direction, where, movement, count, weather, latitude, longitude

How to use it

- Spreadsheets: open data.csv in Excel or Google Sheets.
- Fresh copy: run `python fetch.py` or `node fetch.js`. Both call the URL below and save the response.
- The preview on the Hackachusetts site is a few rows of this same table.

Direct request

https://data.cambridgema.gov/resource/ijm6-q7em.json?$select=countlocation,year,date,timeperiod,street,trafficdirection,cyclistlocation,movementtype,count,weather,latitude,longitude&$where=year%20%3E=%20%272018%27&$order=date%20DESC&$limit=100

Check the source license before publishing a project.
