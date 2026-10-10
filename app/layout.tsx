import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  icons: '/favicon.svg',
  title: '盘口手记 · 记录交易，校准判断',
  description: '保存交易记录、图表截图和复盘笔记，在本地积累自己的交易经验。',
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
