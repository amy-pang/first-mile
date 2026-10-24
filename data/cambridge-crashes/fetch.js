// Save a fresh copy of this Hackachusetts starter source.
// Run with: node fetch.js
const fs = require("node:fs/promises");

const url = "https://data.cambridgema.gov/resource/gb5w-yva3.json?$select=date_time,day_of_week,street_name,cross_street,near_street,location,may_involve_cyclist,may_involve_pedestrian,manner_of_collision,first_harmful_event,ambient_light,weather_condition_1,road_surface_condition,speed_limit,street_or_intersection&$order=date_time%20DESC&$limit=100";

async function main() {
  const response = await fetch(url, { headers: { "User-Agent": "HackachusettsKit" } });
  if (!response.ok) throw new Error("Request failed: " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type") || "";
  let name = "fresh.json";
  if (url.includes(".csv") || type.includes("csv")) name = "fresh.csv";
  if (url.endsWith(".txt")) name = "fresh.txt";
  if (url.endsWith(".jsonl")) name = "fresh.jsonl";
  if (url.endsWith(".parquet")) name = "fresh.parquet";
  await fs.writeFile(name, bytes);
  console.log("wrote " + name + " (" + bytes.length + " bytes)");
}

main();
