import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";

export function SessionUnavailable({ message }: { message?: string }) {
  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Connection needs attention</CardTitle>
        <CardDescription>Staff access is temporarily unavailable.</CardDescription>
      </CardHeader>
      <CardContent>
        <p role="alert" className="text-sm text-muted-foreground">
          {message ?? "Staff access could not be verified. Check the backend connection and try again."}
        </p>
      </CardContent>
      <CardFooter>
        <Button asChild>
          <a href="/admin">Try again</a>
        </Button>
      </CardFooter>
    </Card>
  );
}
