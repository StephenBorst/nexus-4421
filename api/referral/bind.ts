import type { IncomingMessage, ServerResponse } from "http";
import { createHmac } from "crypto";

interface VercelRequest extends IncomingMessage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  query: Record<string, string | string[]>;
  method: string;
}

interface VercelResponse extends ServerResponse {
  status(code: number): VercelResponse;
  json(body: unknown): void;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const { referral_code, account_id } = req.body as {
    referral_code?: string;
    account_id?: string;
  };

  if (!referral_code || typeof referral_code !== "string") {
    return res.status(400).json({ success: false, message: "Missing referral_code" });
  }

  if (!account_id || typeof account_id !== "string") {
    return res.status(400).json({ success: false, message: "Missing account_id" });
  }

  const apiKey = process.env.VITE_ORDERLY_API_KEY;
  const apiSecret = process.env.ORDERLY_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error("Missing VITE_ORDERLY_API_KEY or ORDERLY_API_SECRET env vars");
    return res.status(500).json({ success: false, message: "Server configuration error" });
  }

  const timestamp = Date.now().toString();
  const method = "POST";
  const path = "/v1/referral/bind";
  const body = JSON.stringify({ referral_code });

  const message = `${timestamp}${method}${path}${body}`;
  const signature = createHmac("sha256", apiSecret)
    .update(message)
    .digest("hex");

  try {
    const response = await fetch("https://api.orderly.org/v1/referral/bind", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "orderly-timestamp": timestamp,
        "orderly-account-id": account_id,
        "orderly-key": apiKey,
        "orderly-signature": signature,
      },
      body,
    });

    const data = await response.json() as Record<string, unknown>;

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        message: (data.message as string) || "Failed to bind referral code",
      });
    }

    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    console.error("Error calling Orderly referral bind API:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
