import type { ShopifyClient } from "./client.js";
import { throwIfUserErrors } from "./client.js";
import type { ShopifyUserError } from "./types.js";

const STAGED_UPLOADS_CREATE_MUTATION = /* GraphQL */ `
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
}

/**
 * Upload image bytes to Shopify's staged storage and return a resourceUrl
 * that can be used as `originalSource` for `productCreateMedia`.
 *
 * Pattern: https://shopify.dev/docs/api/admin-graphql/latest/mutations/stagedUploadsCreate
 */
export async function stagedUploadImage(
  client: ShopifyClient,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<string> {
  const data = await client.graphql<{
    stagedUploadsCreate: {
      stagedTargets: StagedTarget[];
      userErrors: ShopifyUserError[];
    };
  }>(STAGED_UPLOADS_CREATE_MUTATION, {
    input: [
      {
        resource: "IMAGE",
        filename,
        mimeType,
        fileSize: String(bytes.length),
        httpMethod: "POST",
      },
    ],
  });
  throwIfUserErrors(
    data.stagedUploadsCreate.userErrors,
    "stagedUploadsCreate",
  );

  const target = data.stagedUploadsCreate.stagedTargets[0];
  if (!target) {
    throw new Error("stagedUploadsCreate returned no target");
  }

  const form = new FormData();
  for (const { name, value } of target.parameters) {
    form.append(name, value);
  }
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);

  const uploadRes = await fetch(target.url, {
    method: "POST",
    body: form,
  });
  if (!uploadRes.ok && uploadRes.status !== 201 && uploadRes.status !== 204) {
    throw new Error(
      `Shopify staged upload POST failed: ${uploadRes.status} ${await uploadRes.text()}`,
    );
  }

  return target.resourceUrl;
}
