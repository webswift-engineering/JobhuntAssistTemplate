import "dotenv/config";
import { z } from "zod";
import { DeepSeekClient } from "../src/llm/client.js";

const llm = new DeepSeekClient();
const schema = z.object({ score: z.number(), reason: z.string() });
const out = await llm.completeJson(
  [
    {
      role: "user",
      content:
        'Rate how well a 5-year Python backend engineer fits a "Senior Node.js API Developer" role. Return JSON {"score": 0..1, "reason": "one sentence"}.',
    },
  ],
  schema
);
console.log("LLM smoke OK:", JSON.stringify(out));
