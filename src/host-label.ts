export function hostLabel(host: { id: string; name: string }, index: number): string {
  return host.name && host.name !== host.id && !/^[a-f0-9-]{12,}$/i.test(host.name) ? host.name : `Компьютер ${index + 1}`;
}
