import { config as loadEnv } from "dotenv";

// モデルを変更するときはここを書き換える。
export const MODEL = "gemini-3.5-flash-lite";
export const MOCK_EVENT_ID = "event-mock";
export const RECENT_MESSAGE_LIMIT = 20;

loadEnv({ path: new URL("../.env", import.meta.url) });

export const PORT = Number(process.env.PORT || 3000);
export const HONO_URL = process.env.HONO_URL || "http://127.0.0.1:" + PORT;
