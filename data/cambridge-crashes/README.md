# Cambridge police crash records

Saved 2026-10-18 for Hackachusetts.

Cambridge police crash records. House number, license plate, age, and sex are not included. Latitude and longitude are taken from the city's location point. The location object on the live call can still contain the city's address string. data.csv does not copy that string. The live call returns the 100 most recent rows.

Rows in data.csv: 17230

Columns: when, day, street, cross_street, near_street, cyclist, pedestrian, manner, first_event, light, weather, road, speed_limit, at, latitude, longitude

How to use it

- Spreadsheets: open data.csv in Excel or Google Sheets.
- Fresh copy: run `python fetch.py` or `node fetch.js`. Both call the URL below and save the response.
- The preview on the Hackachusetts site is a few rows of this same table.

Direct request

https://data.cambridgema.gov/resource/gb5w-yva3.json?$select=date_time,day_of_week,street_name,cross_street,near_street,location,may_involve_cyclist,may_involve_pedestrian,manner_of_collision,first_harmful_event,ambient_light,weather_condition_1,road_surface_condition,speed_limit,street_or_intersection&$order=date_time%20DESC&$limit=100

Check the source license before publishing a project.
