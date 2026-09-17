import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import RequestAccess from './pages/RequestAccess';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import Reservations from './pages/Reservations';
import Arrivals from './pages/Arrivals';
import WalkIn from './pages/WalkIn';
import Guests from './pages/Guests';
import Rooms from './pages/Rooms';
import Housekeeping from './pages/Housekeeping';
import Folios from './pages/Folios';
import Reports from './pages/Reports';
import Audit from './pages/Audit';
import Users from './pages/Users';
import Calendar from './pages/Calendar';
import ChangePassword from './pages/ChangePassword';
import Health from './pages/Health';
import ActivityLog from './pages/ActivityLog';
import ReservationDetail from './pages/ReservationDetail';
import NewReservation from './pages/NewReservation';
import PublicBooking from './pages/PublicBooking';
import GuestPortal from './pages/GuestPortal';
import SimulatedPayment from './pages/SimulatedPayment';
import Revenue from './pages/Revenue';
import Amenities from './pages/Amenities';
import RoomLayouts from './pages/RoomLayouts';
import InspectionScenarios from './pages/InspectionScenarios';
import Messages from './pages/Messages';
import Settings from './pages/Settings';

export default function App() {
  return (
    <Routes>
      {/* The old unlisted "model demo harness". Kept as a redirect so existing
          bookmarks and HOW-TO-OPEN-EDITOR.md keep working. */}
      <Route path="/sim-demo" element={<Navigate to="/room-layouts" replace />} />
      <Route path="/login" element={<Login />} />
      {/* Public: asks for an account, never creates one. */}
      <Route path="/request-access" element={<RequestAccess />} />
      {/* Public by necessity — somebody locked out cannot authenticate to ask for
          a way back in. Neither page reveals whether an address exists. */}
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/book" element={<PublicBooking />} />
      <Route path="/portal/:confirmationNumber" element={<GuestPortal />} />
      {/* Public: opened by scanning a QR code at the front desk. The token in the
          URL is the credential, so there is no login and no app shell. */}
      <Route path="/pay/:token" element={<SimulatedPayment />} />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route
          path="/reservations"
          element={
            <ProtectedRoute section="reservations" roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <Reservations />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reservations/new"
          element={
            <ProtectedRoute section="reservations" roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <NewReservation />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reservations/:id"
          element={
            <ProtectedRoute section="reservations" roles={['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR']}>
              <ReservationDetail />
            </ProtectedRoute>
          }
        />
        <Route
          path="/calendar"
          element={
            // Not housekeeping: the calendar is a booking view (availability and
            // arrivals by date), and that role neither books nor needs the
            // forward book. Their day is the room map.
            <ProtectedRoute section="reservations" roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <Calendar />
            </ProtectedRoute>
          }
        />
        <Route
          path="/arrivals"
          element={
            <ProtectedRoute section="arrivals" roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <Arrivals />
            </ProtectedRoute>
          }
        />
        <Route
          path="/walk-in"
          element={
            <ProtectedRoute section="arrivals" roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <WalkIn />
            </ProtectedRoute>
          }
        />
        <Route
          path="/guests"
          element={
            <ProtectedRoute section="guests" roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <Guests />
            </ProtectedRoute>
          }
        />
        <Route
          path="/rooms"
          element={
            // Property configuration — room records, rate plans and promo codes.
            // Management only: Front Desk looks rooms up through the map and the
            // booking screens, Housekeeping through the map, so neither needs the
            // editor that changes what a room IS.
            <ProtectedRoute section="rooms" roles={['ADMIN', 'MANAGER']}>
              <Rooms />
            </ProtectedRoute>
          }
        />
        <Route
          path="/amenities"
          element={
            <ProtectedRoute section="amenities" roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <Amenities />
            </ProtectedRoute>
          }
        />
        <Route
          path="/housekeeping"
          element={
            <ProtectedRoute
              section="housekeeping"
              roles={['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING_MAINTENANCE']}
            >
              <Housekeeping />
            </ProtectedRoute>
          }
        />
        <Route
          path="/folios"
          element={
            <ProtectedRoute section="folios" roles={['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR']}>
              <Folios />
            </ProtectedRoute>
          }
        />
        <Route
          path="/folios/:id"
          element={
            <ProtectedRoute section="folios" roles={['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR']}>
              <Folios />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reports"
          element={
            <ProtectedRoute section="reports" roles={['ADMIN', 'MANAGER', 'AUDITOR']}>
              <Reports />
            </ProtectedRoute>
          }
        />
        <Route
          path="/revenue"
          element={
            <ProtectedRoute section="reports" roles={['ADMIN', 'MANAGER']}>
              <Revenue />
            </ProtectedRoute>
          }
        />
        <Route path="/change-password" element={<ChangePassword />} />
        {/* No `roles`, mirroring the messages entry in navSections.json, which
            has no `roles` key either — the two are the same fact written twice
            and a mismatch shows up as a visible link that dead-ends. Messaging
            is addressed person-to-person rather than by department, so every
            signed-in role gets it. `section` is still set, so an admin can
            hide it per role from Sidebar Visibility. */}
        <Route
          path="/messages"
          element={
            <ProtectedRoute section="messages">
              <Messages />
            </ProtectedRoute>
          }
        />
        {/* Per-user preferences only, so no role guard — every signed-in account
            has an account and a theme. */}
        <Route path="/settings" element={<Settings />} />
        <Route
          path="/audit"
          element={
            <ProtectedRoute section="audit" roles={['ADMIN', 'AUDITOR', 'MANAGER']}>
              <Audit />
            </ProtectedRoute>
          }
        />
        <Route
          path="/users"
          element={
            <ProtectedRoute section="users" roles={['ADMIN', 'MANAGER']}>
              <Users />
            </ProtectedRoute>
          }
        />
        <Route
          path="/health"
          element={
            // ADMIN only — service health is operational data withheld from
            // MANAGER; see the matching guard on GET /api/health/services.
            <ProtectedRoute section="health" roles={['ADMIN']}>
              <Health />
            </ProtectedRoute>
          }
        />
        {/* ADMIN only, and narrower than Night Audit on purpose: this is the
            record of what every member of staff did, MANAGER included. See the
            matching guard on GET /api/activity and the _rolesComment on the
            "activity" entry in navSections.json — the three are the same fact
            written in three places, and a mismatch shows up as a visible link
            that dead-ends. */}
        <Route
          path="/activity"
          element={
            <ProtectedRoute section="activity" roles={['ADMIN']}>
              <ActivityLog />
            </ProtectedRoute>
          }
        />
        {/* ADMIN only — editing the 3D floor plans changes what every trainee sees,
            and the editor exposes raw layout internals. Narrower than MANAGER on
            purpose. */}
        <Route
          path="/room-layouts"
          element={
            <ProtectedRoute section="room-layouts" roles={['ADMIN']}>
              <RoomLayouts />
            </ProtectedRoute>
          }
        />
        {/* ADMIN only, same reasoning: an authored scenario is what every student
            is graded against. */}
        <Route
          path="/inspection-scenarios"
          element={
            <ProtectedRoute section="room-layouts" roles={['ADMIN']}>
              <InspectionScenarios />
            </ProtectedRoute>
          }
        />
      </Route>
    </Routes>
  );
}
