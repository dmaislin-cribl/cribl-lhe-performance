import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import s from './AppShell.module.css';

export default function AppShell() {
  return (
    <div className={s.shell}>
      <Sidebar />
      <main className={s.main}>
        <Outlet />
      </main>
    </div>
  );
}
