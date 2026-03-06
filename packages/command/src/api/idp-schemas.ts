import { z } from "zod";

export const CreateIdpProviderSchema = z.object({
  type: z.enum(["oidc", "saml", "ldap"]),
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()),
});

export const UpdateIdpProviderSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

export const CreateRoleMappingSchema = z.object({
  idpGroup: z.string().min(1),
  synthRole: z.string().min(1),
});
