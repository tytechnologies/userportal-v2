/**
 * Shared open/close state for the mobile sidebar drawer. AppSidebar renders
 * the drawer; Navbar's hamburger button toggles it.
 */
export const useAppSidebar = () => {
  const mobileOpen = useState<boolean>('app-sidebar-mobile-open', () => false)

  const open = () => { mobileOpen.value = true }
  const close = () => { mobileOpen.value = false }
  const toggle = () => { mobileOpen.value = !mobileOpen.value }

  return { mobileOpen, open, close, toggle }
}
