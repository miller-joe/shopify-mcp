export interface ShopifyUserError {
  field?: string[] | null;
  message: string;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; locations?: unknown; path?: unknown }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

export interface Product {
  id: string;
  title: string;
  handle: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  vendor?: string | null;
  productType?: string | null;
  description?: string | null;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  totalInventory?: number | null;
  featuredImage?: { url: string; altText?: string | null } | null;
}

export interface ProductVariant {
  id: string;
  title: string;
  price: string;
  sku?: string | null;
  inventoryQuantity?: number | null;
  inventoryItem?: { id: string };
}

export interface ProductDetail extends Product {
  variants: { edges: Array<{ node: ProductVariant }> };
  images: { edges: Array<{ node: { url: string; altText?: string | null } }> };
  media?: { edges: Array<{ node: { id: string; mediaContentType: string } }> };
}

export interface Order {
  id: string;
  name: string;
  email?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  createdAt: string;
  lineItems?: { edges: Array<{ node: { title: string; quantity: number } }> };
}

export interface Customer {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  displayName?: string | null;
  numberOfOrders?: string | null;
  amountSpent?: { amount: string; currencyCode: string };
  createdAt?: string;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor?: string | null;
  endCursor?: string | null;
}

export interface Connection<T> {
  edges: Array<{ cursor: string; node: T }>;
  pageInfo: PageInfo;
}
