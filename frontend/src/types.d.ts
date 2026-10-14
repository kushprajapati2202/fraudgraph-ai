// cytoscape-dagre ships no type declarations; it is registered once with cytoscape.use().
declare module "cytoscape-dagre" {
  import type cytoscape from "cytoscape";
  const ext: cytoscape.Ext;
  export default ext;
}
