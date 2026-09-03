import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import RequestAccess from './pages/RequestAccess';
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
import ReservationDetail from './pages/ReservationDetail';
import NewReservation from './pages/NewReservation';
import PublicBooking from './pages/PublicBooking';
import GuestPortal from './pages/GuestPortal';
import Revenue from './pages/Revenue';
import Amenities from './pages/Amenities';
import Training from './pages/Training';
import RoomLayouts from './pages/RoomLayouts';
import InspectionScenarios from './pages/InspectionScenarios';

export default function App() {
  return (
    <Routes>
      {/* The old unlisted "model demo harness". Kept as a redirect so existing
          bookmarks and HOW-TO-OPEN-EDITOR.md keep working. */}
      <Route path="/sim-demo" element={<Navigate to="/room-layouts" replace />} />
      <Route path="/login" element={<Login />} />
      {/* Public: asks for an account, never creates one. */}
      <Route path="/request-access" element={<RequestAccess />} />
      <Route path="/book" element={<PublicBooking />} />
      <Route path="/portal/:confirmationNumber" element={<GuestPortal />} />
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
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <Reservations />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reservations/new"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <NewReservation />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reservations/:id"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR']}>
              <ReservationDetail />
            </ProtectedRoute>
          }
        />
        <Route
          path="/calendar"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING']}>
              <Calendar />
            </ProtectedRoute>
          }
        />
        <Route
          path="/arrivals"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <Arrivals />
            </ProtectedRoute>
          }
        />
        <Route
          path="/walk-in"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <WalkIn />
            </ProtectedRoute>
          }
        />
        <Route
          path="/guests"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <Guests />
            </ProtectedRoute>
          }
        />
        <Route
          path="/rooms"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING']}>
              <Rooms />
            </ProtectedRoute>
          }
        />
        <Route
          path="/amenities"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'FRONT_DESK']}>
              <Amenities />
            </ProtectedRoute>
          }
        />
        <Route
          path="/housekeeping"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING']}>
              <Housekeeping />
            </ProtectedRoute>
          }
        />
        <Route
          path="/training"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'HOUSEKEEPING', 'FRONT_DESK']}>
              <Training />
            </ProtectedRoute>
          }
        />
        <Route
          path="/folios"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR']}>
              <Folios />
            </ProtectedRoute>
          }
        />
        <Route
          path="/folios/:id"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR']}>
              <Folios />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reports"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER', 'AUDITOR']}>
              <Reports />
            </ProtectedRoute>
          }
        />
        <Route
          path="/revenue"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER']}>
              <Revenue />
            </ProtectedRoute>
          }
        />
        <Route path="/change-password" element={<ChangePassword />} />
        <Route
          path="/audit"
          element={
            <ProtectedRoute roles={['ADMIN', 'AUDITOR', 'MANAGER']}>
              <Audit />
            </ProtectedRoute>
          }
        />
        <Route
          path="/users"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER']}>
              <Users />
            </ProtectedRoute>
          }
        />
        <Route
          path="/health"
          element={
            <ProtectedRoute roles={['ADMIN', 'MANAGER']}>
              <Health />
            </ProtectedRoute>
          }
        />
        {/* ADMIN only — editing the 3D floor plans changes what every trainee sees,
            and the editor exposes raw layout internals. Narrower than MANAGER on
            purpose. */}
        <Route
          path="/room-layouts"
          element={
            <ProtectedRoute roles={['ADMIN']}>
              <RoomLayouts />
            </ProtectedRoute>
          }
        />
        {/* ADMIN only, same reasoning: an authored scenario is what every student
            is graded against. */}
        <Route
          path="/inspection-scenarios"
          element={
            <ProtectedRoute roles={['ADMIN']}>
              <InspectionScenarios />
            </ProtectedRoute>
          }
        />
      </Route>
    </Routes>
  );
}
