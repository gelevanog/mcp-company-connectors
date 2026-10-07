import type { Metadata } from 'next';

import './globals.css';
import { Sidebar } from '@/components/Sidebar';

export const metadata: Metadata = {
  title: 'Switchboard console',
  description: 'Who can use which tools, what is waiting for approval, and every call the AI assistants made.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full text-slate-900">
        <Sidebar />
        <main className="min-w-0 flex-1 px-8 py-7">{children}</main>
      </body>
    </html>
  );
}
