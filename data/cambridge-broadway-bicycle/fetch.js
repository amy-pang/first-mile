// Save a fresh copy of this Hackachusetts starter source.
// Run with: node fetch.js
const fs = require("node:fs/promises");

const url = "https://data.cambridgema.gov/resource/q8v9-mcfg.json?$select=datetime,day,total,entries,exits&$where=datetime%20%3E=%20%272024-01-01T00:00:00%27&$order=datetime%20DESC&$limit=100";

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
