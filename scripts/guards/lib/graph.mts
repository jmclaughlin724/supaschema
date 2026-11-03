export interface GraphEdge {
  evidence?: string;
  from: string;
  to: string;
  type: string;
}

export function edgeKey(edge: GraphEdge): string {
  return `${edge.from}\0${edge.to}\0${edge.type}\0${edge.evidence ?? ""}`;
}
