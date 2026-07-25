import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import type { GitHubAppConfig } from "../config.js";
import { GitHubAppClient } from "./github-app.js";

const NOW = 1_800_000_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function config(): GitHubAppConfig {
  return {
    appId: "12345",
    clientId: "Iv1.fixture",
    clientSecret: "client-secret-fixture",
    slug: "harbor-automation",
    privateKey: PRIVATE_KEY,
    privateKeyPath: "/secure/github-app.pem",
    webhookSecret: "webhook-secret-fixture",
  };
}

describe("GitHubAppClient", () => {
  test("signs a bounded RS256 App JWT and preserves OAuth/install state", () => {
    const client = new GitHubAppClient(config(), { now: () => NOW });
    const jwt = client.appJwt();
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      iat: Math.floor(NOW / 1_000) - 60,
      exp: Math.floor(NOW / 1_000) + 540,
      iss: "12345",
    });
    expect(verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      pair.publicKey,
      Buffer.from(signature!, "base64url"),
    )).toBe(true);
    expect(new URL(client.authorizationUrl("state-value")).searchParams.get("state")).toBe("state-value");
    expect(new URL(client.installationUrl("state-value")).pathname).toBe("/apps/harbor-automation/installations/new");
  });

  test("exchanges user OAuth once, validates installation/repository shapes, and caches short token", async () => {
    const calls: string[] = [];
    const fetchMock = (async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      if (url.pathname === "/login/oauth/access_token") {
        expect(String(init?.body)).toContain("client-secret-fixture");
        if (String(init?.body).includes('"grant_type":"refresh_token"')) {
          return Response.json({
            access_token: "ghu_refreshed_secret",
            expires_in: 28_800,
            refresh_token: "ghr_rotated_secret",
            refresh_token_expires_in: 15_811_200,
            token_type: "bearer",
          });
        }
        return Response.json({
          access_token: "ghu_user_secret",
          expires_in: 28_800,
          refresh_token: "ghr_refresh_secret",
          refresh_token_expires_in: 15_811_200,
          token_type: "bearer",
        });
      }
      if (url.pathname === "/user") return Response.json({ id: 42, login: "octo", name: "Octo", email: null, avatar_url: "https://example.test/avatar" });
      if (url.pathname === "/user/installations") return Response.json({ installations: [{
        id: 77, app_id: 12345, target_id: 42, target_type: "User",
        account: { id: 42, login: "octo" }, repository_selection: "selected",
        permissions: { contents: "write", pull_requests: "write" }, suspended_at: null,
      }] });
      if (url.pathname === "/app/installations/77/access_tokens") {
        expect(init?.headers).toEqual(expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer ey/) }));
        return Response.json({ token: "ghs_installation_secret", expires_at: new Date(NOW + 3_600_000).toISOString() });
      }
      if (url.pathname === "/installation/repositories") return Response.json({ repositories: [{
        id: 99, name: "repo", full_name: "octo/repo", private: true,
        default_branch: "main", html_url: "https://github.com/octo/repo",
      }] });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = new GitHubAppClient(config(), { fetch: fetchMock, now: () => NOW });
    const userToken = await client.exchangeUserCode("oauth-code");
    expect(userToken).toEqual(expect.objectContaining({
      accessToken: "ghu_user_secret",
      accessExpiresAt: NOW + 28_800_000,
      refreshToken: "ghr_refresh_secret",
    }));
    expect(await client.user(userToken.accessToken)).toEqual(expect.objectContaining({ id: "42", login: "octo" }));
    expect(await client.userInstallations(userToken.accessToken)).toEqual([expect.objectContaining({ installationId: "77", appId: "12345" })]);
    expect(await client.installationRepositories("77")).toEqual([expect.objectContaining({ repositoryId: "99", fullName: "octo/repo" })]);
    expect(await client.installationToken("77")).toBe("ghs_installation_secret");
    expect(await client.refreshUserToken(userToken.refreshToken!)).toEqual(expect.objectContaining({
      accessToken: "ghu_refreshed_secret",
      refreshToken: "ghr_rotated_secret",
    }));
    expect(calls.filter((call) => call.startsWith("POST /app/installations/77/access_tokens"))).toHaveLength(1);
  });

  test("redacts user or installation credentials from GitHub/network failures", async () => {
    const client = new GitHubAppClient(config(), {
      now: () => NOW,
      fetch: (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const authorization = (init?.headers as Record<string, string>)?.Authorization ?? "";
        throw new Error(`socket failed ${authorization}`);
      }) as unknown as typeof fetch,
    });
    await expect(client.user("ghu_do_not_leak")).rejects.toThrow("[redacted]");
    await expect(client.user("ghu_do_not_leak")).rejects.not.toThrow("ghu_do_not_leak");
  });
});
