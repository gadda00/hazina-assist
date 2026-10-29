"use client";

/**
 * Client-side API helper: attaches the demo session token to every request
 * (x-demo-token header) once the user has signed in. The token is kept in
 * memory only — page refresh lands back on the login screen, which is the
 * right posture for a demo.
 */
let sessionToken: string | null = null;

export function setApiToken(token: string | null) {
  sessionToken = token;
}

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (sessionToken) headers.set("x-demo-token", sessionToken);
  return fetch(input, { ...init, headers });
}
