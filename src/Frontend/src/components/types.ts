export interface FileItem {
  name: string;
  type: "file" | "folder";
  icon: string;
  extension?: string;
}
