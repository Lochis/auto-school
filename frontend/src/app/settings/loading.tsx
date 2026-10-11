import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <main style={{ display: "grid", gap: 14, paddingTop: 20, maxWidth: 760 }}>
      <Skeleton h={30} w={180} />
      <Skeleton h={300} />
    </main>
  );
}
