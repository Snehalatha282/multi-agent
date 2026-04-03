import { search } from 'duck-duck-scrape';

async function test() {
  try {
    const results = await search("Groq AI");
    if (results.results && results.results.length > 0) {
      console.log("SUCCESS:", results.results[0].title);
    } else {
      console.log("No results found.");
    }
  } catch (e) {
    console.error("Error:", e);
  }
}

test();
