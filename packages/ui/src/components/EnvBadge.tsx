function envClass(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("prod")) return "env-badge-production";
  if (lower.includes("stag")) return "env-badge-staging";
  return "env-badge-default";
}

export default function EnvBadge({ name }: { name: string }) {
  return (
    <span className={`env-badge ${envClass(name)}`}>
      {name}
    </span>
  );
}
