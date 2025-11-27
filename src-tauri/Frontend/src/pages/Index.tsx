import { FileExplorer } from "@/components/FileExplorer";
import { AuthWrapper } from "@/components/AuthWrapper";

const Index = () => {
  console.log("Index page rendered");
  return (
    <AuthWrapper>
      <FileExplorer />
    </AuthWrapper>
  );
};

export default Index;