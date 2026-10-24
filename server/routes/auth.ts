import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { createCustomer, EmailTaken, findByEmail, findByGatewayUserId, setGatewayUser, verifyPassword, type Customer } from "../customers.ts";
import { env } from "../env.ts";
import { ApiError, parseJson } from "../http.ts";
import { clearSession, requireCustomer, setSession, type AppEnv } from "../session.ts";
import { TMError } from "../tm/errors.ts";
import { signerPublicKeyCompressedHex } from "../tm/stamp.ts";
import { getSoleOrganizationUser } from "../tm/organization.ts";

const signupBody = z.object({ email: z.email(), password: z.string().min(8), first_name: z.string().regex(/^[A-Za-z]{1,30}$/).optional() });
const loginBody = z.object({ email: z.string().min(1), password: z.string().min(1) });

function profile(customer: Customer) {
  return { first_name: customer.first_name, email: customer.email, wallets: customer.wallets, ready: customer.user_id !== null };
}

function openAccount(email: string, password: string, firstName?: string): Customer {
  try {
    return createCustomer(email, password, firstName);
  } catch (err) {
    if (err instanceof EmailTaken) throw new ApiError(409, "already_exists", err.message);
    throw err;
  }
}

export function authRoutes({ gateway }: AppDeps) {
  // Seating is idempotent on external_ref_id, so a failed attempt is finished by sending the same create again.
  async function seatGatewayUser(customer: Customer) {
    try {
      if (env.TM_LINK_EXISTING_USER) {
        const user = await getSoleOrganizationUser();
        const owner = findByGatewayUserId(user.user_id);
        if (owner && owner.id !== customer.id) throw new ApiError(409, "conflict", "The existing Gateway wallet is already linked to another local account");
        return profile(setGatewayUser(customer.id, user));
      }
      const user = await gateway.createOrganizationUser(customer.external_ref_id, signerPublicKeyCompressedHex);
      return profile(setGatewayUser(customer.id, user));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && err.message === "Existing wallet linking requires exactly one Gateway user in the organization") {
        throw new ApiError(409, "conflict", err.message);
      }
      if (!(err instanceof TMError)) throw err;
      return { ...profile(customer), warning: err.message };
    }
  }

  return new Hono<AppEnv>()
    .post("/signup", async (c) => {
      const { email, password, first_name } = await parseJson(c, signupBody);
      const customer = openAccount(email, password, first_name);
      await setSession(c, customer.id);
      return c.json(await seatGatewayUser(customer), 201);
    })
    .post("/login", async (c) => {
      const { email, password } = await parseJson(c, loginBody);
      const customer = findByEmail(email);
      if (!customer || !verifyPassword(customer, password)) {
        throw new ApiError(401, "unauthenticated", "email or password is incorrect");
      }
      await setSession(c, customer.id);
      return c.json(customer.user_id ? profile(customer) : await seatGatewayUser(customer));
    })
    .post("/logout", (c) => {
      clearSession(c);
      return c.body(null, 204);
    })
    .get("/me", requireCustomer, (c) => c.json(profile(c.var.customer)));
}
