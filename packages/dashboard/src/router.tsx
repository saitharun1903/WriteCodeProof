import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';

/** Two pages do not need a router library: pathname + query, kept in history. */
interface Location {
  path: string;
  query: URLSearchParams;
}

interface Router extends Location {
  navigate(to: string, options?: { replace?: boolean }): void;
}

const RouterContext = createContext<Router | null>(null);

const current = (): Location => ({
  path: window.location.pathname,
  query: new URLSearchParams(window.location.search),
});

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(current);

  useEffect(() => {
    const onPop = () => setLocation(current());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    if (options?.replace) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    setLocation(current());
    if (!options?.replace) window.scrollTo(0, 0);
  }, []);

  return (
    <RouterContext.Provider value={{ ...location, navigate }}>{children}</RouterContext.Provider>
  );
}

export function useRouter(): Router {
  const router = useContext(RouterContext);
  if (!router) throw new Error('useRouter outside RouterProvider');
  return router;
}

/** An <a> that navigates in place; modified clicks still open a new tab. */
export function Link({ to, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useRouter();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} {...rest} onClick={onClick} />;
}
