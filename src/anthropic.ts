const ENDPOINT = "https://api.anthropic.com/v1/messages";

export interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
}

/** Thin Anthropic Messages client. Posts a raw JSON body (bytes from pxpipe)
 *  and returns the parsed response. */
export const postMessages = async (
  body: Uint8Array,
  apiKey: string,
): Promise<AnthropicResponse> => {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as AnthropicResponse;
};

export const responseText = (res: AnthropicResponse): string =>
  res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
