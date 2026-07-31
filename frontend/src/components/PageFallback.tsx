/** PageFallback —— 懒加载页面统一 Suspense fallback（iOS 风格居中 spinner） */
export function PageFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-ios-bg">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-primary" />
    </div>
  );
}

export default PageFallback;
