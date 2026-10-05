import { Message } from './components.js';
import { Link, RouterProvider, useRouter } from './router.js';
import { RunPage } from './RunPage.js';
import { RunsPage } from './RunsPage.js';

const RUN_PATH = /^\/runs\/([0-9a-f-]{36})\/?$/i;

function Page() {
  const { path } = useRouter();
  if (path === '/' || path === '') return <RunsPage />;
  const run = RUN_PATH.exec(path);
  if (run) return <RunPage id={run[1]!} />;
  return (
    <Message title="This page does not exist.">
      <p>
        <Link to="/">Go to all runs</Link>
      </p>
    </Message>
  );
}

export function App() {
  return (
    <RouterProvider>
      <div className="topbar">
        <div className="topbar__inner">
          <Link to="/" className="brand">
            <img src="/favicon.svg" alt="" width="20" height="20" />
            WriteCode Proof
          </Link>
        </div>
      </div>
      <main className="page">
        <Page />
      </main>
    </RouterProvider>
  );
}
