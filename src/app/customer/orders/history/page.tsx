import { CustomerOrdersView, type OrdersSearchParams } from "../orders-view";

export const dynamic = "force-dynamic";

export default function OrderHistoryPage({ searchParams }: { searchParams: Promise<OrdersSearchParams> }) {
  return <CustomerOrdersView searchParams={searchParams} view="history" />;
}
