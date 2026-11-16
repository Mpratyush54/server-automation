import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * OAuth client registered through dynamic client registration (RFC 7591, POST /api/oauth/register),
 * used by AI assistants connecting to the remote MCP endpoint. Always a public client
 * (token_endpoint_auth_method "none", PKCE required). A registered client can do nothing until a
 * person approves it on the portal consent screen (see McpGrant). The static OIDC clients
 * (Grafana, Argo CD, ...) are not stored here; they stay in lib/oidc-clients.ts.
 */
@Entity('oauth_clients')
@Index('oauth_clients_client_id', ['clientId'], { unique: true })
@Index('oauth_clients_pending', ['approvedAt', 'registrationIpHash'])
export class OAuthClient {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Public client identifier, `mcp_` + random. */
  @Column({ type: 'varchar', length: 64, name: 'client_id' })
  clientId: string;

  /** Display name, sanitised at registration (lib/mcp-oauth.ts sanitizeClientName). */
  @Column({ type: 'varchar', length: 100, name: 'client_name' })
  clientName: string;

  /** Exact redirect URIs (https, or http on a loopback address). */
  @Column({ type: 'jsonb', name: 'redirect_uris' })
  redirectUris: string[];

  @Column({ type: 'jsonb', name: 'grant_types' })
  grantTypes: string[];

  /** Optional software_id / software_version reported by the client (informational). */
  @Column({ type: 'varchar', length: 200, nullable: true, name: 'software_id' })
  softwareId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'software_version' })
  softwareVersion: string | null;

  /** SHA-256 of the registering address; bounds pending registrations per address. */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'registration_ip_hash' })
  registrationIpHash: string | null;

  /** First time a person approved this client; null = never approved (pruned after an hour). */
  @Column({ type: 'timestamp', nullable: true, name: 'approved_at' })
  approvedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
