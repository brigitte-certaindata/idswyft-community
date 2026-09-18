import { Routes, Route } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './components/layout/Layout'
import UserVerificationPage from './pages/UserVerificationPage'
import { LiveCapturePage } from './pages/LiveCapturePage'
import MobileVerificationPage from './pages/MobileVerificationPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { LegalPage } from './pages/LegalPage'
import { VerifyCredentialPage } from './pages/VerifyCredentialPage'

// Developer portal, demo, page-builder, admin (login/verifications/
// developers), and every /docs/* page are deliberately not imported/routed
// below — this deployment serves only the capture flow. The page files
// themselves (DeveloperPage.tsx, DemoPage.tsx, PageBuilderPage.tsx,
// AdminLogin.tsx, VerificationManagement.tsx, DevelopersList.tsx,
// Docs*.tsx, ReviewDashboardDocs.tsx, MarkdownDocsPage.tsx, SetupPage.tsx,
// and components/docs/DocLayout.tsx) are left untouched on disk —
// unimported, they're dropped from the built bundle same as if deleted,
// but upstream changes to them still merge cleanly.

function App() {
  return (
    <ErrorBoundary>
    <Layout>
      <Routes>
        {/* Root: portal removed — nothing applicant/integrator-facing lives here */}
        <Route path="/" element={<NotFoundPage />} />

        <Route path="/verify-credential" element={<VerifyCredentialPage />} />

        {/* Capture flow */}
        <Route path="/user-verification" element={<UserVerificationPage />} />
        <Route path="/v/:slug" element={<UserVerificationPage />} />
        <Route path="/live-capture" element={<LiveCapturePage />} />
        <Route path="/verify/mobile" element={<MobileVerificationPage />} />
        <Route path="/legal" element={<LegalPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
    </ErrorBoundary>
  )
}

export default App
