const API_BASE = "https://og.nexustradinglabs.com";

export interface Comment {
  id: string;
  wallet: string;
  text: string;
  createdAt: number;
}

export async function fetchComments(thesisId: string): Promise<Comment[]> {
  const r = await fetch(`${API_BASE}/comments/${thesisId}`);
  if (!r.ok) throw new Error(`fetchComments: ${r.status}`);
  return r.json() as Promise<Comment[]>;
}

export async function fetchReactions(thesisId: string): Promise<Record<string, string[]>> {
  const r = await fetch(`${API_BASE}/reactions/${thesisId}`);
  if (!r.ok) throw new Error(`fetchReactions: ${r.status}`);
  return r.json() as Promise<Record<string, string[]>>;
}

export async function addComment(
  thesisId: string,
  wallet: string,
  text: string,
  // Ride-along call context so the worker can notify the call's author.
  ctx?: { authorWallet?: string; symbol?: string; direction?: string },
): Promise<void> {
  const r = await fetch(`${API_BASE}/comments/${thesisId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet, text, ...(ctx ?? {}) }),
  });
  if (!r.ok) throw new Error(`addComment: ${r.status}`);
}

export async function deleteComment(
  thesisId: string,
  commentId: string,
  wallet: string,
): Promise<void> {
  const r = await fetch(`${API_BASE}/comments/${thesisId}/${commentId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  if (!r.ok) throw new Error(`deleteComment: ${r.status}`);
}

export async function toggleReaction(
  thesisId: string,
  emoji: string,
  wallet: string,
): Promise<void> {
  const r = await fetch(`${API_BASE}/reactions/${thesisId}/${encodeURIComponent(emoji)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  if (!r.ok) throw new Error(`toggleReaction: ${r.status}`);
}
