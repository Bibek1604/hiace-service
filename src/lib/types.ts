export type TripView = {
  id: string;
  departure: string;
  arrival: string;
  fare: number;
  boardingPoint: string;
  dropPoint: string;
  status: string;
  bookingOpen: boolean;
  available?: number;
  stops: TripStopView[];
  journey: { from: number; to: number };
  boardsAt: string;
  dropsAt: string;
  points?: BoardingPointView[];
  vehicle: {
    id: string;
    name: string;
    registration: string;
    type: string;
    operator: string;
    operatorContact: string;
    amenities: string[];
    description: string;
    images: { key: string }[];
  };
  route: {
    origin: { name: string };
    destination: { name: string };
    distanceKm: number;
    durationMinutes: number;
    stops: { location: { name: string } }[];
  };
  assignments: { driver: { name: string; photoKey?: string } }[];
  seats: { id: string; label: string; row: number; column: number; deck: number; state: string }[];
};
export type TripStopView = { locationId: string; name: string; offsetMinutes: number; allowBoarding: boolean; allowDropoff: boolean };
export type BoardingPointView = { id: string; locationId: string; kind: 'BOARDING' | 'DROPOFF'; name: string; landmark: string; extraMinutes: number };
export type BookingView = {
  id: string;
  reference: string;
  amount: number;
  status: string;
  expiresAt: string;
  createdAt: string;
  customer: { name: string; phone: string };
  trip: TripView;
  journey: { from: string; to: string; boardsAt: string; dropsAt: string; boardingPoint: string; dropPoint: string };
  seats: { tripSeat: { vehicleSeat: { label: string } } }[];
  payment: {
    id: string;
    status: string;
    note: string;
    transactionRef: string | null;
    proofs: { id: string; imageKey: string; createdAt: string }[];
  } | null;
  qrSnapshot: {
    label: string;
    accountName: string;
    accountNumber?: string;
    imageKey: string;
    instructions: string;
  };
};
