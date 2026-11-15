import { CustomerOrdersView, type OrdersSearchParams } from "./orders-view";

export const dynamic = "force-dynamic";

export default function OrdersPage({ searchParams }: { searchParams: Promise<OrdersSearchParams> }) {
  return <CustomerOrdersView searchParams={searchParams} view="current" />;
}
