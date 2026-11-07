export type Field = {
  key: string;
  label: string;
  type?:
    | 'text'
    | 'number'
    | 'textarea'
    | 'password'
    | 'email'
    | 'tel'
    | 'datetime-local'
    | 'checkbox'
    | 'list'
    | 'image'
    | 'images'
    | 'select';
  source?: 'vehicles' | 'drivers' | 'locations' | 'routes' | 'qrs' | 'layouts';
  options?: string[];
  required?: boolean;
  default?: string | boolean | number;
};
export const fields: Record<string, Field[]> = {
  vehicles: [
    { key: 'name', label: 'Vehicle name', required: true },
    { key: 'registration', label: 'Registration number', required: true },
    {
      key: 'type',
      label: 'Vehicle type',
      type: 'select',
      options: ['Bus', 'Deluxe Bus', 'Hiace', 'Jeep', 'Car'],
      required: true,
    },
    { key: 'operator', label: 'Owner name', required: true },
    { key: 'operatorContact', label: 'Owner contact', type: 'tel', required: true },
    { key: 'emergencyContact', label: 'Emergency contact', type: 'tel', required: true },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'amenities', label: 'Amenities (comma separated)', type: 'list' },
    {
      key: 'layoutVersionId',
      label: 'Seat layout (fixed once the vehicle is registered)',
      type: 'select',
      source: 'layouts',
    },
    {
      key: 'seatLabels',
      label: 'Or plain seat labels in rows of four (only when no layout is chosen)',
      type: 'list',
    },
    { key: 'imageKeys', label: 'Vehicle photos', type: 'images' },
    { key: 'maintenanceNote', label: 'Maintenance / availability notes', type: 'textarea' },
    { key: 'active', label: 'Operational', type: 'checkbox', default: true },
  ],
  drivers: [
    { key: 'name', label: 'Full name', required: true },
    { key: 'email', label: 'Staff email', type: 'email', required: true },
    {
      key: 'password',
      label: 'Password (12+ characters; leave blank to keep current)',
      type: 'password',
    },
    { key: 'mobile', label: 'Mobile', type: 'tel', required: true },
    { key: 'licenseNumber', label: 'License number', required: true },
    { key: 'licenseExpiry', label: 'License expiry', type: 'datetime-local', required: true },
    { key: 'emergencyContact', label: 'Emergency contact', type: 'tel', required: true },
    { key: 'address', label: 'Address' },
    { key: 'photoKey', label: 'Profile photo', type: 'image' },
    { key: 'status', label: 'Account status', type: 'select', options: ['ACTIVE', 'DEACTIVATED', 'SUSPENDED'], default: 'ACTIVE' },
  ],
  locations: [{ key: 'name', label: 'Location name', required: true }],
  routes: [
    { key: 'originId', label: 'Origin', type: 'select', source: 'locations', required: true },
    {
      key: 'destinationId',
      label: 'Destination',
      type: 'select',
      source: 'locations',
      required: true,
    },
    { key: 'distanceKm', label: 'Distance (km)', type: 'number', required: true },
    {
      key: 'durationMinutes',
      label: 'Estimated travel time (hours)',
      type: 'number',
      required: true,
    },
    { key: 'baseFare', label: 'Base fare (NPR)', type: 'number', required: true },
    { key: 'stopIds', label: 'Intermediate location IDs in order, comma separated', type: 'list' },
    { key: 'active', label: 'Active', type: 'checkbox', default: true },
  ],
  fares: [
    { key: 'routeId', label: 'Route', type: 'select', source: 'routes', required: true },
    {
      key: 'vehicleType',
      label: 'Vehicle type',
      type: 'select',
      options: ['Bus', 'Deluxe Bus', 'Hiace', 'Jeep', 'Car'],
      required: true,
    },
    { key: 'fare', label: 'Fare (NPR)', type: 'number', required: true },
  ],
  trips: [
    { key: 'vehicleId', label: 'Vehicle', type: 'select', source: 'vehicles', required: true },
    { key: 'routeId', label: 'Route', type: 'select', source: 'routes', required: true },
    {
      key: 'driverId',
      label: 'Assigned driver',
      type: 'select',
      source: 'drivers',
      required: true,
    },
    {
      key: 'paymentQRId',
      label: 'Payment QR account',
      type: 'select',
      source: 'qrs',
      required: true,
    },
    { key: 'departure', label: 'Departure (Nepal time)', type: 'datetime-local', required: true },
    {
      key: 'arrival',
      label: 'Estimated arrival (Nepal time)',
      type: 'datetime-local',
      required: true,
    },
    { key: 'boardingPoint', label: 'Boarding point', required: true },
    { key: 'dropPoint', label: 'Drop-off point', required: true },
    { key: 'fare', label: 'Fare per seat (NPR)', type: 'number', required: true },
    {
      key: 'status',
      label: 'Trip status',
      type: 'select',
      options: ['SCHEDULED', 'BOARDING', 'DEPARTED', 'COMPLETED', 'CANCELLED'],
      default: 'SCHEDULED',
    },
    { key: 'bookingOpen', label: 'Accept bookings', type: 'checkbox', default: true },
  ],
  'payment-qr': [
    { key: 'label', label: 'Bank / wallet name', required: true },
    { key: 'accountName', label: 'Account holder', required: true },
    { key: 'accountNumber', label: 'Account number (optional)' },
    { key: 'operator', label: 'Owner name (optional; must match vehicle)' },
    { key: 'imageKey', label: 'Payment QR image', type: 'image', required: true },
    { key: 'instructions', label: 'Payment instructions', type: 'textarea', required: true },
    { key: 'active', label: 'Active', type: 'checkbox', default: true },
  ],
  settings: [
    {
      key: 'holdMinutes',
      label: 'Customer hold (minutes, 1–60)',
      type: 'number',
      required: true,
      default: 10,
    },
    {
      key: 'reviewMinutes',
      label: 'Admin review window (minutes, 1–120)',
      type: 'number',
      required: true,
      default: 15,
    },
  ],
};
