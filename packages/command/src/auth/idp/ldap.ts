import ldap from "ldapjs";
import type { IdpUser } from "@deploystack/core";
import type { IdpAdapter } from "./types.js";

export interface LdapConfig {
  url: string;              // e.g. ldaps://dc.corp.example.com:636
  bindDn: string;           // service account DN
  bindCredential: string;   // service account password (encrypted at rest)
  searchBase: string;       // e.g. ou=Users,dc=corp,dc=example,dc=com
  searchFilter: string;     // e.g. (sAMAccountName={{username}})
  groupSearchBase: string;  // e.g. ou=Groups,dc=corp,dc=example,dc=com
  groupSearchFilter: string; // e.g. (member={{dn}})
  useTls: boolean;
  tlsCaPath?: string;
}

export interface LdapAuthenticateParams {
  username: string;
  password: string;
  config: LdapConfig;
}

interface LdapSearchEntry {
  dn: string;
  attributes: Array<{ type: string; values: string[] }>;
}

/**
 * Creates an ldapjs client with optional TLS settings.
 */
function createClient(config: LdapConfig): ldap.Client {
  const clientOpts: ldap.ClientOptions = {
    url: config.url,
    connectTimeout: 10_000,
    timeout: 10_000,
  };

  if (config.useTls && config.tlsCaPath) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    clientOpts.tlsOptions = {
      ca: [fs.readFileSync(config.tlsCaPath)],
      rejectUnauthorized: true,
    };
  }

  return ldap.createClient(clientOpts);
}

/**
 * Promisified bind operation.
 */
function bindAsync(client: ldap.Client, dn: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Promisified unbind operation.
 */
function unbindAsync(client: ldap.Client): Promise<void> {
  return new Promise((resolve) => {
    client.unbind((err) => {
      // Ignore unbind errors — best-effort cleanup
      resolve();
    });
  });
}

/**
 * Promisified search operation. Returns an array of entry objects.
 */
function searchAsync(
  client: ldap.Client,
  base: string,
  opts: ldap.SearchOptions,
): Promise<LdapSearchEntry[]> {
  return new Promise((resolve, reject) => {
    client.search(base, opts, (err, res) => {
      if (err) return reject(err);

      const entries: LdapSearchEntry[] = [];
      res.on("searchEntry", (entry) => {
        const obj = entry.pojo;
        entries.push({
          dn: obj.objectName,
          attributes: obj.attributes.map((a) => ({
            type: a.type,
            values: a.values,
          })),
        });
      });
      res.on("error", (searchErr) => reject(searchErr));
      res.on("end", () => resolve(entries));
    });
  });
}

/**
 * Extracts a named attribute value from an LDAP entry.
 */
function getAttr(entry: LdapSearchEntry, name: string): string {
  const attr = entry.attributes.find(
    (a) => a.type.toLowerCase() === name.toLowerCase(),
  );
  return attr?.values[0] ?? "";
}

/**
 * LDAP/Active Directory adapter -- implements IdpAdapter for LDAP-based identity providers.
 *
 * Authentication flow:
 * 1. Bind with service account credentials
 * 2. Search for the user by username
 * 3. Bind with the user's DN + provided password
 * 4. Query group memberships (supports AD nested groups via matching rule OID)
 * 5. Return IdpUser
 */
export class LdapAdapter implements IdpAdapter {
  type = "ldap";

  async authenticate(params: unknown): Promise<IdpUser> {
    const { username, password, config } = params as LdapAuthenticateParams;

    if (!username || !password) {
      throw new Error("Username and password are required");
    }

    const client = createClient(config);

    try {
      // Step 1: Bind with service account
      await bindAsync(client, config.bindDn, config.bindCredential);

      // Step 2: Search for user by username
      const filter = config.searchFilter.replace(/\{\{username\}\}/g, escapeFilterValue(username));

      const userEntries = await searchAsync(client, config.searchBase, {
        filter,
        scope: "sub",
        attributes: ["dn", "mail", "email", "displayName", "cn", "sAMAccountName", "userPrincipalName", "uid"],
      });

      if (userEntries.length === 0) {
        throw new Error(`User not found: ${username}`);
      }

      const userEntry = userEntries[0];
      const userDn = userEntry.dn;

      // Step 3: Bind as the user to verify their password
      const userClient = createClient(config);
      try {
        await bindAsync(userClient, userDn, password);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        throw new Error(`Invalid credentials for user ${username}: ${message}`);
      } finally {
        await unbindAsync(userClient);
      }

      // Step 4: Query group memberships (re-bind as service account)
      // Use AD's LDAP_MATCHING_RULE_IN_CHAIN (1.2.840.113556.1.4.1941)
      // for nested group resolution when the filter contains {{dn}}
      let groupFilter = config.groupSearchFilter.replace(/\{\{dn\}\}/g, escapeFilterValue(userDn));

      // If the server is Active Directory (URL contains ldaps/ldap and filter uses member),
      // enhance with the transitive membership matching rule for nested groups
      const useNestedGroups = config.groupSearchFilter.includes("member={{dn}}");
      if (useNestedGroups) {
        groupFilter = config.groupSearchFilter.replace(
          "member={{dn}}",
          `member:1.2.840.113556.1.4.1941:=${escapeFilterValue(userDn)}`,
        );
      }

      let groups: string[] = [];
      try {
        const groupEntries = await searchAsync(client, config.groupSearchBase, {
          filter: groupFilter,
          scope: "sub",
          attributes: ["cn", "dn"],
        });
        groups = groupEntries.map((entry) => getAttr(entry, "cn") || entry.dn);
      } catch {
        // Group search may fail if groupSearchBase is misconfigured — return empty groups
        groups = [];
      }

      // Step 5: Build IdpUser
      const email =
        getAttr(userEntry, "mail") ||
        getAttr(userEntry, "email") ||
        getAttr(userEntry, "userPrincipalName") ||
        "";

      const displayName =
        getAttr(userEntry, "displayName") ||
        getAttr(userEntry, "cn") ||
        username;

      return {
        externalId: userDn,
        email,
        displayName,
        groups,
        provider: "ldap",
      };
    } finally {
      await unbindAsync(client);
    }
  }

  async validateConfig(config: unknown): Promise<{ valid: boolean; error?: string }> {
    const c = config as Record<string, unknown>;

    // Required fields
    if (!c.url || typeof c.url !== "string") {
      return { valid: false, error: "url is required and must be a string" };
    }
    if (!c.bindDn || typeof c.bindDn !== "string") {
      return { valid: false, error: "bindDn is required and must be a string" };
    }
    if (!c.bindCredential || typeof c.bindCredential !== "string") {
      return { valid: false, error: "bindCredential is required and must be a string" };
    }
    if (!c.searchBase || typeof c.searchBase !== "string") {
      return { valid: false, error: "searchBase is required and must be a string" };
    }
    if (!c.searchFilter || typeof c.searchFilter !== "string") {
      return { valid: false, error: "searchFilter is required and must be a string" };
    }
    if (!c.groupSearchBase || typeof c.groupSearchBase !== "string") {
      return { valid: false, error: "groupSearchBase is required and must be a string" };
    }
    if (!c.groupSearchFilter || typeof c.groupSearchFilter !== "string") {
      return { valid: false, error: "groupSearchFilter is required and must be a string" };
    }

    // Validate URL format (must be ldap:// or ldaps://)
    try {
      const url = new URL(c.url);
      if (!["ldap:", "ldaps:"].includes(url.protocol)) {
        return { valid: false, error: "url must use ldap:// or ldaps:// protocol" };
      }
    } catch {
      return { valid: false, error: "url must be a valid URL (e.g. ldaps://dc.corp.example.com:636)" };
    }

    // Validate that searchFilter contains {{username}} placeholder
    if (!(c.searchFilter as string).includes("{{username}}")) {
      return { valid: false, error: "searchFilter must contain {{username}} placeholder" };
    }

    // Validate that groupSearchFilter contains {{dn}} placeholder
    if (!(c.groupSearchFilter as string).includes("{{dn}}")) {
      return { valid: false, error: "groupSearchFilter must contain {{dn}} placeholder" };
    }

    return { valid: true };
  }

  /**
   * Tests the LDAP connection by attempting a service account bind.
   * Returns success/error without authenticating any user.
   */
  async testConnection(config: LdapConfig): Promise<{ success: boolean; error?: string }> {
    const validation = await this.validateConfig(config);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const client = createClient(config);
    try {
      await bindAsync(client, config.bindDn, config.bindCredential);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return { success: false, error: `Service account bind failed: ${message}` };
    } finally {
      await unbindAsync(client);
    }
  }

  /**
   * Tests whether a specific user can be found in the LDAP directory.
   * Uses the service account to search — does not authenticate the user.
   */
  async testUser(
    config: LdapConfig,
    username: string,
  ): Promise<{ found: boolean; userDn?: string; email?: string; displayName?: string; error?: string }> {
    const validation = await this.validateConfig(config);
    if (!validation.valid) {
      return { found: false, error: validation.error };
    }

    const client = createClient(config);
    try {
      await bindAsync(client, config.bindDn, config.bindCredential);

      const filter = config.searchFilter.replace(/\{\{username\}\}/g, escapeFilterValue(username));
      const entries = await searchAsync(client, config.searchBase, {
        filter,
        scope: "sub",
        attributes: ["dn", "mail", "email", "displayName", "cn", "sAMAccountName", "userPrincipalName"],
      });

      if (entries.length === 0) {
        return { found: false, error: `No user found matching: ${username}` };
      }

      const entry = entries[0];
      return {
        found: true,
        userDn: entry.dn,
        email: getAttr(entry, "mail") || getAttr(entry, "email") || getAttr(entry, "userPrincipalName") || undefined,
        displayName: getAttr(entry, "displayName") || getAttr(entry, "cn") || undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return { found: false, error: `LDAP search failed: ${message}` };
    } finally {
      await unbindAsync(client);
    }
  }
}

/**
 * Escapes special characters in an LDAP filter value per RFC 4515.
 */
function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\/\x00]/g, (ch) => {
    return "\\" + ch.charCodeAt(0).toString(16).padStart(2, "0");
  });
}
